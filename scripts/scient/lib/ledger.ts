/**
 * The divergence ledger, `scripts/scient/divergences.json`: every way Scient
 * Agent differs from the Oh My Pi release it is built from, by contract.
 *
 * An entry names the files Scient owns outright and the Oh My Pi files it
 * changes. A change inside an Oh My Pi file is wrapped in a marker block that
 * carries the entry's id (see markers.ts); a JSON change is registered by JSON
 * pointer; a removed Oh My Pi file is listed as deleted; a file that cannot
 * hold a marker without changing what it does (a prompt sent to a model) is
 * listed as unmarked, with the reason.
 */
import * as fs from "node:fs";

export type EntryStatus = "active" | "upstreamed" | "retired";

export interface LedgerEntry {
	status: EntryStatus;
	/** What stays true while the entry is active. */
	contract: string;
	/** Files Scient adds. Exact paths or globs (`*` within a segment, `**` across segments). */
	owned?: string[];
	/** Oh My Pi files that carry this entry's marker blocks. */
	upstream?: string[];
	/** Oh My Pi JSON files this entry changes, by the JSON pointers it may change. */
	json?: Record<string, string[]>;
	/** Oh My Pi files this entry removes. */
	deleted?: string[];
	/** Oh My Pi files this entry changes without markers, with the reason. */
	unmarked?: Record<string, string>;
	/** How the contract is checked. Documentation only: the checker never runs these. */
	verification?: string[];
	/** For an upstreamed or retired entry: why, and the alignment that ended it. */
	disposition?: string;
}

export interface Ledger {
	schemaVersion: 1;
	entries: Record<string, LedgerEntry>;
}

const ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
/** A repository path: forward slashes, no `.` or `..` segments, nothing leading or trailing. */
const PATH = /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\\0]+(?<!\/)$/;
/** An RFC 6901 JSON pointer. */
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;
const KEYS = new Set([
	"status",
	"contract",
	"owned",
	"upstream",
	"json",
	"deleted",
	"unmarked",
	"verification",
	"disposition",
]);

/** Reads and validates a ledger, throwing with every problem it finds. */
export function parseLedger(text: string, source = "divergences.json"): Ledger {
	const value: unknown = JSON.parse(text);
	const problems: string[] = [];
	const record = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);
	const strings = (v: unknown) => Array.isArray(v) && v.every(item => typeof item === "string");
	if (!record(value) || value.schemaVersion !== 1 || !record(value.entries)) {
		throw new Error(`${source}: expected { "schemaVersion": 1, "entries": { ... } }`);
	}
	for (const [id, entry] of Object.entries(value.entries)) {
		const where = `${source}: ${id}`;
		if (!ID.test(id)) problems.push(`${where}: an id is upper-case words joined by hyphens`);
		if (!record(entry)) {
			problems.push(`${where}: not an object`);
			continue;
		}
		for (const key of Object.keys(entry)) if (!KEYS.has(key)) problems.push(`${where}: unknown key "${key}"`);
		if (!["active", "upstreamed", "retired"].includes(entry.status as string))
			problems.push(`${where}: status is active, upstreamed or retired`);
		if (typeof entry.contract !== "string" || !entry.contract.trim()) problems.push(`${where}: contract is required`);
		for (const key of ["owned", "upstream", "deleted", "verification"]) {
			if (entry[key] !== undefined && !strings(entry[key])) problems.push(`${where}: ${key} is a list of strings`);
		}
		if (entry.json !== undefined && (!record(entry.json) || !Object.values(entry.json).every(strings))) {
			problems.push(`${where}: json maps a path to a list of JSON pointers`);
		}
		if (
			entry.unmarked !== undefined &&
			(!record(entry.unmarked) || !Object.values(entry.unmarked).every(v => typeof v === "string" && v.trim()))
		) {
			problems.push(`${where}: unmarked maps a path to its reason`);
		}
		if (entry.status !== "active" && (typeof entry.disposition !== "string" || !entry.disposition.trim())) {
			problems.push(`${where}: an ${entry.status} entry records its disposition`);
		}
		const paths = [
			...((entry.owned as string[] | undefined) ?? []),
			...((entry.upstream as string[] | undefined) ?? []),
			...((entry.deleted as string[] | undefined) ?? []),
			...Object.keys((entry.json as object | undefined) ?? {}),
			...Object.keys((entry.unmarked as object | undefined) ?? {}),
		];
		for (const file of paths) {
			if (typeof file === "string" && !PATH.test(file))
				problems.push(`${where}: "${file}" is not a normalized repository path`);
		}
		for (const pointers of Object.values((entry.json as Record<string, unknown> | undefined) ?? {})) {
			for (const pointer of Array.isArray(pointers) ? pointers : []) {
				if (typeof pointer === "string" && !POINTER.test(pointer))
					problems.push(`${where}: "${pointer}" is not a JSON pointer`);
			}
		}
	}
	if (problems.length > 0) throw new Error(problems.join("\n"));
	return value as unknown as Ledger;
}

export function readLedger(file: string): Ledger {
	return parseLedger(fs.readFileSync(file, "utf8"), file);
}

/** Whether a repository path matches an exact path or a glob. */
export function matchesPath(pattern: string, file: string): boolean {
	if (!pattern.includes("*")) return pattern === file;
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*" && pattern[i + 1] === "*") {
			// `**/` matches zero or more whole segments; a trailing `**` matches the rest.
			if (pattern[i + 2] === "/") {
				source += "(?:[^/]+/)*";
				i += 2;
			} else {
				source += ".*";
				i += 1;
			}
		} else if (char === "*") {
			source += "[^/]*";
		} else {
			source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`).test(file);
}

/** The active entries, with their ids. */
export function activeEntries(ledger: Ledger): [string, LedgerEntry][] {
	return Object.entries(ledger.entries).filter(([, entry]) => entry.status === "active");
}

/** Entries that own a path Scient added. */
export function ownersOf(ledger: Ledger, file: string): string[] {
	return activeEntries(ledger)
		.filter(([, entry]) => entry.owned?.some(pattern => matchesPath(pattern, file)))
		.map(([id]) => id);
}
