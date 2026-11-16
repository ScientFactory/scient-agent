import { describe, expect, it } from "bun:test";
import { convertTools } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { Model, TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function antigravityModel(id: string): Model<"google-gemini-cli"> {
	return buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

type SchemaNode = { type?: string; enum?: unknown[]; properties?: Record<string, SchemaNode>; items?: SchemaNode };

describe("Cloud Code Assist tool parameters with enums that are not strings", () => {
	it("keep each value's type and drop the enum Google rejects", () => {
		// The shape of a real rejection: "Invalid value at 'request.tools[0].function_declarations[45]
		// .parameters.properties[2].value.items.properties[6].value.enum[0]' (TYPE_STRING), -1".
		const tool: Tool = {
			name: "edit_rows",
			description: "Edit rows",
			parameters: {
				type: "object",
				properties: {
					rows: {
						type: "array",
						items: {
							type: "object",
							properties: {
								direction: { type: "integer", enum: [-1, 1] },
								step: { enum: [-1, 1] },
								flag: { type: "boolean", enum: [true] },
								mixed: { enum: ["auto", 0] },
								mode: { type: "string", enum: ["read", "write"] },
							},
						},
					},
				},
			} as unknown as TJsonSchema,
		};
		const model = antigravityModel("claude-opus-4-6");
		expect(model.compat.ccaLegacyParametersSchema).toBe(true);

		const [declarations] = convertTools([tool], model) ?? [];
		const parameters = declarations?.functionDeclarations[0]?.parameters as SchemaNode;
		const row = parameters.properties?.rows?.items?.properties;
		if (!row) throw new Error("Expected the row schema to survive conversion");

		expect(row.direction).toEqual({ type: "integer" });
		expect(row.step).toEqual({ type: "number" });
		expect(row.flag).toEqual({ type: "boolean" });
		expect(row.mixed).not.toHaveProperty("enum");
		expect(row.mode).toEqual({ type: "string", enum: ["read", "write"] });
	});
});
