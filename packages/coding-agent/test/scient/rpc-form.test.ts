import { describe, expect, it } from "bun:test";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { RpcExtensionUIResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { askFormOnAskCard, type RpcFormDialogRequest, rpcFormDialog } from "@oh-my-pi/pi-coding-agent/scient/rpc-form";

const FORM = `<form>
  <p>Two of the 40 samples failed quality control.</p>
  <ul><li>S07: low read depth</li><li>S31: contamination</li></ul>
  <fieldset>
    <legend>Failed samples</legend>
    <label><input type="radio" name="failed" value="drop" checked> Drop them</label>
    <label><input type="radio" name="failed" value="keep"> Keep them, flagged</label>
  </fieldset>
  <p>Which plots should the report include?</p>
  <label><input type="checkbox" name="plots" value="pca" checked> PCA</label>
  <label><input type="checkbox" name="plots" value="volcano"> Volcano</label>
  <label>Contact email <input type="email" name="email" required></label>
  <label>Notes <textarea name="notes"></textarea></label>
</form>`;

/** A host card that answers each round with `answer(questions)` and records what it was shown. */
function card(...rounds: Array<(questions: ExtensionAskDialogQuestion[]) => ExtensionAskDialogResult | undefined>) {
	const shown: ExtensionAskDialogQuestion[][] = [];
	return {
		shown,
		ui: {
			askDialog: async (questions: ExtensionAskDialogQuestion[], _options?: ExtensionUIDialogOptions) => {
				shown.push(questions);
				const round = rounds[shown.length - 1];
				if (!round) throw new Error("unexpected card");
				return round(questions);
			},
		},
	};
}

const submit = (
	answers: Record<string, { selectedOptions?: string[]; customInput?: string }>,
): ExtensionAskDialogResult => ({
	kind: "submit",
	results: Object.entries(answers).map(([id, answer]) => ({
		id,
		question: id,
		options: [],
		multi: false,
		selectedOptions: answer.selectedOptions ?? [],
		...(answer.customInput === undefined ? {} : { customInput: answer.customInput }),
	})),
});

describe("the ask tool's form on a host's ask card", () => {
	it("puts every field on one card with the form's findings and the agent's recommendation", async () => {
		const host = card(() =>
			submit({ failed: { selectedOptions: ["Drop them"] }, email: { customInput: "a@b.org" } }),
		);
		await askFormOnAskCard(host.ui, FORM);
		const [questions] = host.shown;
		expect(questions!.map(question => question.id)).toEqual(["failed", "plots", "email", "notes"]);
		const [failed, plots, email, notes] = questions!;
		expect(failed!.question).toContain("Two of the 40 samples failed quality control.");
		expect(failed!.question).toContain("- S31: contamination");
		expect(failed!.question).toContain("Failed samples");
		expect(failed!.options.map(option => option.label)).toEqual(["Drop them", "Keep them, flagged"]);
		expect(failed!).toMatchObject({ multi: false, recommended: 0 });
		// The text right before the checkboxes is their question, not context.
		expect(plots!.question).toBe("Which plots should the report include?");
		expect(plots!).toMatchObject({ multi: true, recommended: 0 });
		expect(email!).toMatchObject({ question: "Contact email", options: [], multi: false });
		expect(notes!).toMatchObject({ question: "Notes", options: [], multi: true });
	});

	it("shows a text field's example once, whether or not the placeholder says e.g.", async () => {
		const host = card(() => submit({ alpha: { customInput: "0.01" }, n: { customInput: "20" } }));
		await askFormOnAskCard(
			host.ui,
			`<form><label>Significance level <input name="alpha" placeholder="e.g. 0.05" required></label><label>Sample size <input name="n" placeholder="20" required></label></form>`,
		);
		const [alpha, n] = host.shown[0]!;
		expect(alpha!.question).toBe("Significance level\n\nFor example: 0.05");
		expect(n!.question).toBe("Sample size\n\nFor example: 20");
	});

	it("returns the form's data from the card's answers", async () => {
		const host = card(() =>
			submit({
				failed: { customInput: "Rerun S07 only" },
				plots: { selectedOptions: ["PCA", "Volcano"], customInput: "Heatmap" },
				email: { customInput: "lab@example.org" },
				notes: {},
			}),
		);
		expect(await askFormOnAskCard(host.ui, FORM)).toEqual({
			data: { failed: "Rerun S07 only", plots: ["pca", "volcano", "Heatmap"], email: "lab@example.org", notes: "" },
		});
	});

	it("brings back only a field whose answer fails, with the reason", async () => {
		const host = card(
			() => submit({ failed: { selectedOptions: ["Keep them, flagged"] }, email: { customInput: "not an email" } }),
			() => submit({ email: { customInput: "lab@example.org" } }),
		);
		const result = await askFormOnAskCard(host.ui, FORM);
		expect(host.shown[1]!.map(question => question.id)).toEqual(["email"]);
		expect(host.shown[1]![0]!.question).toBe("Contact email\n\nEnter an email address");
		expect(result?.data).toMatchObject({ failed: "keep", email: "lab@example.org" });
	});

	it("keeps a choice the form offers no free text for when only free text comes back", async () => {
		const host = card(() => submit({ unit: { customInput: "parsecs" } }));
		const html = `<form><label>Unit <select name="unit"><option value="km" selected>km</option><option value="mi">mi</option></select></label></form>`;
		expect(await askFormOnAskCard(host.ui, html)).toEqual({ data: { unit: "km" } });
	});

	it("is cancelled when the card is", async () => {
		expect(await askFormOnAskCard(card(() => undefined).ui, FORM)).toBeUndefined();
		expect(await askFormOnAskCard(card(() => ({ kind: "chat" })).ui, FORM)).toBeUndefined();
	});

	it("submits the form's current values at the deadline", async () => {
		const ui = {
			askDialog: async (_questions: ExtensionAskDialogQuestion[], options?: ExtensionUIDialogOptions) => {
				options?.onTimeout?.();
				return undefined;
			},
		};
		expect(await askFormOnAskCard(ui, FORM, { timeout: 1000 })).toEqual({
			data: { failed: "drop", plots: ["pca"], email: "", notes: "" },
			timedOut: true,
		});
	});
});

describe("the RPC context's form dialog", () => {
	const sent: Record<string, unknown>[] = [];
	const answering =
		(response: RpcExtensionUIResponse): RpcFormDialogRequest =>
		async (_opts, request, parse) => {
			sent.push(request);
			return parse(response);
		};
	const html = `<form><label><input type="radio" name="go" value="yes" checked> Yes</label><label><input type="radio" name="go" value="no"> No</label></form>`;

	it("sends the whole form to a host that draws forms", async () => {
		const formDialog = rpcFormDialog(
			{ formDialogEnabled: true, askDialog: undefined },
			answering({ type: "extension_ui_response", id: "1", data: { go: "no" } }),
		);
		expect(await formDialog!(html, { timeout: 5000 })).toEqual({ data: { go: "no" } });
		expect(sent.at(-1)).toEqual({ method: "form", html, timeout: 5000 });
		const withHidden = html.replace("</form>", '<input type="hidden" name="step" value="2"></form>');
		expect(await formDialog!(withHidden)).toEqual({ data: { step: "2", go: "no" } });
	});

	it("refuses data for a field the form does not have", async () => {
		const formDialog = rpcFormDialog(
			{ formDialogEnabled: true, askDialog: undefined },
			answering({ type: "extension_ui_response", id: "1", data: { other: "x" } }),
		);
		await expect(formDialog!(html)).rejects.toThrow('unknown field "other"');
	});

	it("submits the form's current values when the host's deadline passes", async () => {
		const formDialog = rpcFormDialog(
			{ formDialogEnabled: true, askDialog: undefined },
			answering({ type: "extension_ui_response", id: "1", cancelled: true, timedOut: true }),
		);
		expect(await formDialog!(html)).toEqual({ data: { go: "yes" }, timedOut: true });
	});

	it("uses the ask card for a host that only has one, and nothing for a host with neither", async () => {
		const host = card(() => submit({ go: { selectedOptions: ["No"] } }));
		const formDialog = rpcFormDialog(
			{ formDialogEnabled: false, askDialog: host.ui.askDialog },
			answering(undefined!),
		);
		expect(await formDialog!(html)).toEqual({ data: { go: "no" } });
		expect(rpcFormDialog({ formDialogEnabled: false, askDialog: undefined }, answering(undefined!))).toBeUndefined();
	});
});
