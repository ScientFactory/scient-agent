/**
 * The `ask` tool's HTML form over RPC (SA-ASK-FORM).
 *
 * Since Oh My Pi 18.18.3 the `ask` tool sends one HTML form, and a host
 * without a form surface (RPC included) is asked one field at a time.
 * - A host that sends `set_form_dialog` receives the whole form
 *   (`method: "form"`) and answers with its data.
 * - A host that only sends `set_ask_dialog`, such as Scient Desktop before
 *   forms, gets every field on its one ask card: choices as options, text
 *   fields as free-text questions, and the form's other content in the
 *   question text. An answer the card cannot check is asked again on its own.
 */
import {
	choiceValue,
	defaultFormData,
	fieldError,
	fieldQuestions,
	type HtmlFormData,
	isArrayChoice,
	textValue,
} from "@oh-my-pi/pi-tui/html-form/data";
import {
	type ChoiceField,
	type FormBlock,
	type FormField,
	type HtmlForm,
	parseHtmlForm,
	spansText,
	type TextField,
} from "@oh-my-pi/pi-tui/html-form/parse";
import { disambiguateDisplayLabels } from "@oh-my-pi/pi-tui/render/render-utils";
import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	ExtensionAskDialogQuestion,
	ExtensionFormDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../extensibility/extensions";
import type { RpcExtensionUIResponse } from "../modes/rpc/rpc-types";

/** Sends one extension UI request and parses its answer, as `requestRpcDialog` does. */
export type RpcFormDialogRequest = (
	opts: ExtensionUIDialogOptions,
	request: Record<string, unknown>,
	parse: (response: RpcExtensionUIResponse) => ExtensionFormDialogResult | undefined,
) => Promise<ExtensionFormDialogResult | undefined>;

/**
 * Sends the whole form to a host that draws forms. The answer is the form's
 * data; a deadline, the agent's or the host's, submits the form's current
 * values, as the terminal's form does.
 */
export async function requestRpcFormDialog(
	request: RpcFormDialogRequest,
	html: string,
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<ExtensionFormDialogResult | undefined> {
	const form = parseHtmlForm(html);
	let timedOut = false;
	const opts: ExtensionUIDialogOptions = {
		...dialogOptions,
		onTimeout: () => {
			timedOut = true;
			dialogOptions?.onTimeout?.();
		},
	};
	const result = await request(opts, { method: "form", html, timeout: dialogOptions?.timeout }, response =>
		parseFormResponse(response, form, opts),
	);
	return timedOut ? { data: defaultFormData(form), timedOut: true } : result;
}

function parseFormResponse(
	response: RpcExtensionUIResponse,
	form: HtmlForm,
	opts: ExtensionUIDialogOptions,
): ExtensionFormDialogResult | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) opts.onTimeout?.();
		return undefined;
	}
	const data: unknown = "data" in response ? response.data : undefined;
	if (!isRecord(data)) throw new Error("Form response must carry a data object");
	const names = new Set([...form.fields.map(field => field.name), ...form.hidden.map(([name]) => name)]);
	// Hidden inputs submit as written, whether or not the host returns them.
	const submitted: HtmlFormData = Object.fromEntries(form.hidden);
	for (const [name, value] of Object.entries(data)) {
		if (!names.has(name)) throw new Error(`Form response names unknown field ${JSON.stringify(name)}`);
		const valid =
			typeof value === "string" ||
			(typeof value === "number" && Number.isFinite(value)) ||
			(Array.isArray(value) && value.every(item => typeof item === "string"));
		if (!valid) throw new Error(`Form field ${JSON.stringify(name)} must be text, a number or a list of text`);
		submitted[name] = value;
	}
	return { data: submitted };
}

type AskCardUI = Required<Pick<ExtensionUIContext, "askDialog">>;

/** One named field on the card, with the option labels the card shows for it. */
interface CardField {
	field: FormField;
	question: ExtensionAskDialogQuestion;
	/** Option index by the label shown on the card; choice fields only. */
	optionByLabel: Map<string, number>;
}

/**
 * Asks a form on the host's ask card. The card checks no type, pattern or
 * length, so a field whose answer fails comes back on the card with the
 * reason. Undefined when the user cancels; a deadline submits the form's
 * current values, with the card's recommended answers.
 */
export async function askFormOnAskCard(
	ui: AskCardUI,
	html: string,
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<ExtensionFormDialogResult | undefined> {
	const form = parseHtmlForm(html);
	const data = defaultFormData(form);
	let asking = cardFields(form);
	const errors = new Map<CardField, string>();
	while (asking.length > 0) {
		let timedOut = false;
		const result = await ui.askDialog(
			asking.map(entry => {
				const error = errors.get(entry);
				return error ? { ...entry.question, question: `${entry.question.question}\n\n${error}` } : entry.question;
			}),
			{
				...dialogOptions,
				onTimeout: () => {
					timedOut = true;
					dialogOptions?.onTimeout?.();
				},
			},
		);
		if (timedOut) return { data, timedOut: true };
		if (!result || result.kind !== "submit") return undefined;
		const answers = new Map(result.results.map(item => [item.id, item]));
		for (const entry of asking) {
			const answer = answers.get(entry.question.id);
			if (answer) applyAnswer(data, entry, answer.selectedOptions, answer.customInput);
		}
		errors.clear();
		asking = asking.filter(entry => {
			const error = fieldError(entry.field, data[entry.field.name]);
			if (error) errors.set(entry, error);
			return error !== undefined;
		});
	}
	return { data };
}

function applyAnswer(data: HtmlFormData, entry: CardField, selected: string[], customInput: string | undefined): void {
	const { field, optionByLabel } = entry;
	const typed = customInput?.trim() ? customInput : undefined;
	if (field.kind === "text") {
		if (typed !== undefined) data[field.name] = textValue(field, typed);
		return;
	}
	const checked = new Set(selected.flatMap(label => optionByLabel.get(label) ?? []));
	// Free text is an answer only where the form offers "Other"; elsewhere the field keeps its choices.
	if (checked.size === 0 && typed !== undefined && !field.other) return;
	const value = choiceValue(field, checked, typed);
	if (value === undefined) delete data[field.name];
	else data[field.name] = value;
}

function cardFields(form: HtmlForm): CardField[] {
	const questions = fieldQuestions(form);
	const context = contextBefore(form);
	const fields: CardField[] = [];
	for (const field of form.fields) {
		if (!field.name) continue;
		const asked = questions.get(field) ?? field.name;
		const before = (context.get(field) ?? []).filter(part => part !== asked);
		const question = [...before, asked].join("\n\n");
		if (field.kind === "choice") fields.push(choiceCard(field, field.name, question));
		else fields.push(textCard(field, field.name, question));
	}
	return fields;
}

function choiceCard(field: ChoiceField, id: string, question: string): CardField {
	const offered = field.options.flatMap((option, index) => (option.disabled ? [] : [{ option, index }]));
	const labels = disambiguateDisplayLabels(
		offered.map(({ option }) => spansText(option.label).replace(/\s+/g, " ").trim() || option.value),
		[],
	);
	const optionByLabel = new Map(labels.map((label, row) => [label, offered[row]!.index]));
	const recommended = offered.findIndex(({ option }) => option.checked);
	return {
		field,
		optionByLabel,
		question: {
			id,
			question,
			options: labels.map(label => ({ label })),
			// A lone checkbox is one yes-or-no choice, which may stay unchecked.
			multi: isArrayChoice(field) || (field.multi && !field.required),
			...(recommended === -1 ? {} : { recommended }),
		},
	};
}

function textCard(field: TextField, id: string, question: string): CardField {
	// A placeholder often starts with its own "e.g."; the card already says "For example".
	const hint = field.value || field.placeholder?.replace(/^\s*(?:e\.?\s?g\.?|for example)\s*[:,]?\s*/iu, "");
	return {
		field,
		optionByLabel: new Map(),
		question: {
			id,
			question: hint ? `${question}\n\n${field.value ? "Current" : "For example"}: ${hint}` : question,
			options: [],
			// The card requires an answer to a single-choice question; an optional field may stay empty.
			multi: !field.required,
		},
	};
}

/**
 * The form's content that is not a question (findings, lists, tables, code,
 * pictures), shown in front of the next field's question on the card. The text
 * right before an unlabelled field is that field's question, so it is left out.
 */
function contextBefore(form: HtmlForm): Map<FormField, string[]> {
	const context = new Map<FormField, string[]>();
	let pending: string[] = [];
	for (const section of form.sections) {
		const title = spansText(section.title).trim();
		if (title) pending.push(title);
		let caption = false;
		for (const block of section.blocks) {
			if (block.kind === "field") {
				if (caption && !hasOwnQuestion(block.field)) pending.pop();
				if (pending.length > 0) context.set(block.field, pending);
				pending = [];
				caption = false;
				continue;
			}
			const text = blockText(block);
			caption = block.kind === "text" && text !== "";
			if (text) pending.push(text);
		}
	}
	return context;
}

function hasOwnQuestion(field: FormField): boolean {
	return spansText(field.label).trim() !== "";
}

function blockText(block: Exclude<FormBlock, { kind: "field" }>): string {
	switch (block.kind) {
		case "text":
			return spansText(block.spans).trim();
		case "list":
			return block.items
				.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${spansText(item).trim()}`)
				.join("\n");
		case "pre":
			return `\`\`\`\n${block.text}\n\`\`\``;
		case "table":
			return block.rows.map(row => `| ${row.map(cell => spansText(cell).trim()).join(" | ")} |`).join("\n");
		case "image":
			return block.alt ? `[Picture: ${block.alt}]` : "";
		case "svg":
			return block.alt ? `[Diagram: ${block.alt}]` : "";
	}
}

/**
 * The RPC context's `formDialog`: the host's own form when it sent
 * `set_form_dialog`, else its ask card when it sent `set_ask_dialog`, else
 * none, and the `ask` tool asks one field at a time as upstream does.
 */
export function rpcFormDialog(
	host: { readonly formDialogEnabled: boolean; readonly askDialog: ExtensionUIContext["askDialog"] },
	request: RpcFormDialogRequest,
): ExtensionUIContext["formDialog"] {
	if (host.formDialogEnabled) return (html, opts) => requestRpcFormDialog(request, html, opts);
	const askDialog = host.askDialog;
	if (askDialog) return (html, opts) => askFormOnAskCard({ askDialog }, html, opts);
	return undefined;
}
