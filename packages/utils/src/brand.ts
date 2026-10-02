/**
 * Scient Agent's symbol, a Möbius strip, as a complete SVG document (512 × 512,
 * scale it with CSS). It is the symbol Scient Desktop shows for the agent
 * (`apps/web/src/assets/scient-agent-symbol.svg` there); when the symbol changes,
 * copy that file over `brand/scient-agent-symbol.svg`.
 */
import symbol from "./brand/scient-agent-symbol.svg" with { type: "text" };

export const SCIENT_AGENT_SYMBOL_SVG: string = symbol;
