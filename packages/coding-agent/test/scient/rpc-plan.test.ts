import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolvePlanFilePath } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import {
	PLAN_APPROVE_OPTION,
	PLAN_REFINE_OPTION,
	RpcPlanController,
	type RpcPlanProposedFrame,
	type RpcPlanSession,
} from "@oh-my-pi/pi-coding-agent/scient/rpc-plan";
import type { PlanProposalHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("RPC plan mode", () => {
	let tempDir: TempDir;
	let planState: PlanModeState | undefined;
	let handler: PlanProposalHandler | undefined;
	let referencePath: string | undefined;
	let modeChanges: Array<{ mode: string; data?: Record<string, unknown> }>;
	let goalActive: boolean;
	let frames: RpcPlanProposedFrame[];
	let answers: Array<PromiseWithResolvers<string | undefined>>;
	let sessionId: string;

	async function controller(): Promise<RpcPlanController> {
		const settings = await Settings.loadIsolated({ agentDir: tempDir.path(), cwd: tempDir.path() });
		const session = {
			settings,
			sessionManager: {
				getCwd: () => tempDir.path(),
				getArtifactsDir: () => path.join(tempDir.path(), "artifacts"),
				getSessionId: () => sessionId,
				appendModeChange: (mode: string, data?: Record<string, unknown>) => {
					modeChanges.push({ mode, data });
				},
			},
			getPlanModeState: () => planState,
			setPlanModeState: (state: PlanModeState | undefined) => {
				planState = state;
			},
			setPlanProposalHandler: (next: PlanProposalHandler | null) => {
				handler = next ?? undefined;
			},
			setPlanReferencePath: (next: string) => {
				referencePath = next;
			},
			sendPlanModeContext: async () => {},
			getGoalModeState: () => (goalActive ? { enabled: true } : undefined),
			isStreaming: false,
		} as unknown as RpcPlanSession;
		return new RpcPlanController(
			session,
			{
				select: () => {
					const answer = Promise.withResolvers<string | undefined>();
					answers.push(answer);
					return answer.promise;
				},
			},
			frame => frames.push(frame),
		);
	}

	/** Enters plan mode and drafts the plan file the agent would write. */
	async function draft(plans: RpcPlanController, markdown = "# Fit the model\n\n1. Load data\n"): Promise<void> {
		expect(await plans.handle({ op: "enter" })).toEqual({ enabled: true, planFilePath: "local://PLAN.md" });
		const localProtocolOptions = {
			getArtifactsDir: () => path.join(tempDir.path(), "artifacts"),
			getSessionId: () => sessionId,
		};
		await Bun.write(resolvePlanFilePath("local://PLAN.md", { localProtocolOptions, cwd: tempDir.path() }), markdown);
	}

	/** The agent proposes; resolves once the host has been asked, with the pending tool result. */
	async function propose(): Promise<{ result: Promise<unknown> }> {
		if (!handler) throw new Error("plan mode installed no proposal handler");
		const asked = answers.length;
		const result = handler("PLAN");
		while (answers.length === asked) await Promise.race([result, Bun.sleep(1)]);
		return { result };
	}

	const resultText = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;

	beforeEach(() => {
		tempDir = TempDir.createSync("@scient-rpc-plan-");
		planState = undefined;
		handler = undefined;
		referencePath = undefined;
		modeChanges = [];
		goalActive = false;
		frames = [];
		answers = [];
		sessionId = `scient-rpc-plan-${crypto.randomUUID()}`;
	});

	afterEach(async () => {
		try {
			await tempDir.remove();
		} catch {}
	});

	it("shows the proposed plan, and an approval leaves plan mode so the run carries it out", async () => {
		const plans = await controller();
		await draft(plans);
		const { result } = await propose();
		expect(frames).toMatchObject([{ type: "plan_proposed", markdown: "# Fit the model\n\n1. Load data\n" }]);
		answers[0]!.resolve(PLAN_APPROVE_OPTION);

		expect(resultText(await result)).toStartWith(`Plan approved at ${frames[0]!.planFilePath}.`);
		expect(await plans.handle({ op: "get" })).toEqual({ enabled: false });
		expect(handler).toBeUndefined();
		expect(referencePath).toBe(frames[0]!.planFilePath);
		expect(modeChanges).toEqual([{ mode: "none", data: { approvedPlanFilePath: frames[0]!.planFilePath } }]);
	});

	it("keeps planning on Refine, a typed answer, or a cancelled question", async () => {
		const plans = await controller();
		await draft(plans);
		for (const [answer, expected] of [
			[PLAN_REFINE_OPTION, "Stop here and ask the user what to change"],
			["Use a mixed model instead", "The user asked: Use a mixed model instead"],
			[undefined, "Stop here and ask the user what to change"],
		] as const) {
			const { result } = await propose();
			answers.at(-1)!.resolve(answer);
			expect(resultText(await result)).toContain(expected);
			expect((await plans.handle({ op: "get" })).enabled).toBe(true);
		}
		expect(referencePath).toBeUndefined();
	});

	it("never approves an answer that arrives after plan mode was left", async () => {
		const plans = await controller();
		await draft(plans);
		const { result } = await propose();
		await plans.handle({ op: "exit" });
		answers[0]!.resolve(PLAN_APPROVE_OPTION);

		await expect(result).rejects.toThrow("Plan mode ended before the plan was approved.");
		expect(referencePath).toBeUndefined();
		expect(modeChanges).toEqual([]);
	});

	it("refuses to plan while a goal is set", async () => {
		goalActive = true;
		const plans = await controller();
		await expect(plans.handle({ op: "enter" })).rejects.toThrow("Drop or finish the goal before planning.");
		expect(planState).toBeUndefined();
	});
});
