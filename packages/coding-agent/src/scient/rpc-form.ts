/**
 * Presents the ask tool's HTML form on an RPC host's ask card (SA-ASK-FORM).
 * The RPC context selects this conversion when the host enables ask dialogs.
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
import type {
	ExtensionAskDialogQuestion,
	ExtensionFormDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
} from "../extensibility/extensions";

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
