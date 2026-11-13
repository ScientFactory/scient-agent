/**
 * Plan mode for RPC hosts. Oh My Pi offers plan mode only in its terminal and to
 * ACP clients; this controller gives an RPC host the same flow:
 *
 * - `plan enter` turns plan mode on: the agent may read and draft a plan file,
 *   but changes nothing else, until it proposes the plan by writing its title to
 *   `xd://propose`.
 * - The proposal sends the plan to the host (`plan_proposed`), then asks Approve
 *   or Refine on the host's select card while the tool call waits. Approve leaves
 *   plan mode and the same run goes on to carry out the plan; Refine (or any
 *   other answer, which is read as feedback) keeps planning. A cancelled or
 *   abandoned question never approves: only an explicit Approve does.
 * - `plan exit` leaves plan mode without a plan.
 */
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../extensibility/extensions";
import type { LocalProtocolOptions } from "../internal-urls";
import { normalizePlanTitle, type PlanApprovalDetails, resolveApprovedPlan } from "../plan-mode/approved-plan";
import { autosaveApprovedPlan } from "../plan-mode/plan-autosave";
import { listPlanFiles, readPlanFile } from "../plan-mode/plan-files";
import { cfgPlanEnabled } from "../plan-mode/settings";
import type { AgentSession } from "../session/agent-session";

export const PLAN_APPROVE_OPTION = "Approve and carry out";
export const PLAN_REFINE_OPTION = "Refine plan";
const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";

export type RpcPlanOp = "get" | "enter" | "exit";

export interface RpcPlanCommand {
	op: RpcPlanOp;
}

export interface RpcPlanResult {
	/** Plan mode is on: the agent plans and changes nothing until a plan is approved. */
	enabled: boolean;
	/** The plan file the agent drafts, while plan mode is on. */
	planFilePath?: string;
}

/** The plan the agent proposed, sent before the host is asked to approve it. */
export interface RpcPlanProposedFrame {
	type: "plan_proposed";
	title: string;
	planFilePath: string;
	markdown: string;
}

export type RpcPlanSession = Pick<
	AgentSession,
	| "settings"
	| "sessionManager"
	| "getPlanModeState"
	| "setPlanModeState"
	| "setPlanProposalHandler"
	| "setPlanReferencePath"
	| "sendPlanModeContext"
	| "getGoalModeState"
	| "isStreaming"
>;

export class RpcPlanController {
	readonly #session: RpcPlanSession;
	readonly #ui: Pick<ExtensionUIContext, "select">;
	readonly #output: (frame: RpcPlanProposedFrame) => void;
	/** Bumped when plan mode is left, so an approval answered afterwards changes nothing. */
	#generation = 0;

	constructor(
		session: RpcPlanSession,
		ui: Pick<ExtensionUIContext, "select">,
		output: (frame: RpcPlanProposedFrame) => void,
	) {
		this.#session = session;
		this.#ui = ui;
		this.#output = output;
	}

	get #state(): RpcPlanResult {
		const state = this.#session.getPlanModeState();
		return state?.enabled ? { enabled: true, planFilePath: state.planFilePath } : { enabled: false };
	}

	async handle(command: RpcPlanCommand): Promise<RpcPlanResult> {
		switch (command.op) {
			case "get":
				return this.#state;
			case "enter":
				await this.#enter();
				return this.#state;
			case "exit":
				this.#exit();
				return this.#state;
			default: {
				const op: never = command.op;
				throw new Error(`Unknown plan op: ${String(op)}`);
			}
		}
	}

	async #enter(): Promise<void> {
		const session = this.#session;
		if (session.getPlanModeState()?.enabled) return;
		if (!cfgPlanEnabled.get(session.settings)) throw new Error("Plan mode is disabled (plan.enabled).");
		if (session.getGoalModeState()) throw new Error("Drop or finish the goal before planning.");
		const previous = session.getPlanModeState();
		session.setPlanModeState({
			enabled: true,
			planFilePath: previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,
			workflow: previous?.workflow ?? "parallel",
			reentry: previous !== undefined,
		});
		const generation = this.#generation;
		session.setPlanProposalHandler(title => this.#propose(title, generation));
		if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: "steer" });
	}

	#exit(): void {
		this.#generation++;
		this.#session.setPlanProposalHandler(null);
		this.#session.setPlanModeState(undefined);
	}

	#localProtocolOptions(): LocalProtocolOptions {
		const manager = this.#session.sessionManager;
		return { getArtifactsDir: () => manager.getArtifactsDir(), getSessionId: () => manager.getSessionId() };
	}

	async #propose(title: string, generation: number): Promise<AgentToolResult<PlanApprovalDetails>> {
		const session = this.#session;
		const state = session.getPlanModeState();
		if (!state?.enabled || generation !== this.#generation) throw new ToolError("Plan mode is not active.");
		const localProtocolOptions = this.#localProtocolOptions();
		const cwd = session.sessionManager.getCwd();
		const plan = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url => readPlanFile(url, { localProtocolOptions, cwd }),
			listPlanFiles: () => listPlanFiles({ localProtocolOptions }),
		});
		const details: PlanApprovalDetails = { planFilePath: plan.planFilePath, title: plan.title, planExists: true };
		this.#output({
			type: "plan_proposed",
			title: plan.title,
			planFilePath: plan.planFilePath,
			markdown: plan.planContent,
		});
		const answer = (
			await this.#ui.select(`Carry out the plan "${plan.title}"?`, [PLAN_APPROVE_OPTION, PLAN_REFINE_OPTION])
		)?.trim();
		if (generation !== this.#generation) throw new ToolError("Plan mode ended before the plan was approved.");
		if (answer !== PLAN_APPROVE_OPTION) {
			// The next planning turn targets the plan just reviewed.
			if (state.planFilePath !== plan.planFilePath)
				session.setPlanModeState({ ...state, planFilePath: plan.planFilePath });
			const title = normalizePlanTitle(plan.title).title;
			// Without feedback, the user says what to change in their next message.
			const text =
				answer && answer !== PLAN_REFINE_OPTION
					? `The plan was not approved. The user asked: ${answer} Update the plan file, then write ${title} to xd://propose again when it is ready.`
					: `The plan was not approved. Stop here and ask the user what to change; plan mode stays on. When they answer, update the plan file and write ${title} to xd://propose again.`;
			return {
				content: [{ type: "text", text }],
				details,
			};
		}
		session.setPlanReferencePath(plan.planFilePath);
		this.#exit();
		session.sessionManager.appendModeChange("none", { approvedPlanFilePath: plan.planFilePath });
		const autosaved = await autosaveApprovedPlan({
			settings: session.settings,
			cwd,
			title: plan.title,
			planContent: plan.planContent,
		}).then(
			() => true,
			error => {
				logger.warn("Failed to autosave approved plan", { error: String(error) });
				return false;
			},
		);
		return {
			content: [
				{
					type: "text",
					text: `Plan approved at ${plan.planFilePath}. Plan mode exited; proceed with the implementation.${autosaved ? "" : " (Plan autosave failed; continuing.)"}`,
				},
			],
			details,
		};
	}
}
