import { SCIENT_AGENT_SYMBOL_SVG } from "@oh-my-pi/pi-utils/scient/brand";

/** Oh My Pi's mark on the page every browser sign-in ends on (`registry/oauth/oauth.html`). */
const OMP_MARK = /<svg class="omp-mark"[\s\S]*?<\/svg>/;

/**
 * Scient's colors for the page's accents, dark and light. They override the
 * page's own variables, which its accent gradient and glows are drawn from.
 */
const SCIENT_STYLE = `<style>
	:root {
		--accent-a: #5ba2c2;
		--accent-b: #f8ac8b;
		--glow-a: rgb(91 162 194 / 0.1);
		--glow-b: rgb(248 172 139 / 0.08);
	}
	@media (prefers-color-scheme: light) {
		:root {
			--accent-a: #3b82a6;
			--accent-b: #e0835e;
			--glow-a: rgb(59 130 166 / 0.08);
			--glow-b: rgb(224 131 94 / 0.06);
		}
	}
	.scient-mark { flex: none; display: block; width: 24px; height: 24px; }
	.scient-mark svg { display: block; width: 100%; height: 100%; }
</style>
`;

/**
 * The sign-in result page with Scient Agent's symbol and colors in place of
 * Oh My Pi's mark and accents. The page's words are the wording generator's.
 */
export function brandCallbackPage(template: string): string {
	return template
		.replace(OMP_MARK, () => `<span class="scient-mark" aria-hidden="true">${SCIENT_AGENT_SYMBOL_SVG}</span>`)
		.replace("</head>", () => `${SCIENT_STYLE}</head>`);
}
