import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * Accessibility audit helper for the CeraUI a11y CI gate (Task 7).
 *
 * The gate is deliberately narrow: it fails the build only on `critical` and
 * `serious` impact violations. Pre-existing violations are recorded in
 * `tests/e2e/a11y-baseline.json` (a per-page rule-id allowlist) so the gate
 * never breaks CI on day one — only a NEW critical/serious rule firing on a
 * covered page fails the run. Lower-impact issues (moderate/minor) are reported
 * in the evidence JSON but do not gate.
 */

/** The two impact levels that gate the build. */
export const GATED_IMPACTS = ['critical', 'serious'] as const;
export type GatedImpact = (typeof GATED_IMPACTS)[number];

/** A flattened, JSON-friendly view of one axe violation. */
export interface AxeViolationSummary {
	id: string;
	impact: string;
	help: string;
	helpUrl: string;
	nodes: number;
	/** First few CSS target selectors — enough to locate, capped to keep evidence small. */
	targets: string[];
}

function isGated(impact: string | null | undefined): impact is GatedImpact {
	return impact === 'critical' || impact === 'serious';
}

/**
 * Run axe-core against the current page state and return only the
 * critical/serious violations as a compact, serialisable summary.
 *
 * Uses the default WCAG 2.0/2.1 A + AA rule set; severity (not tag) is what
 * gates, so the impact filter is the single source of truth for "does this fail
 * the build".
 */
export async function runAxe(page: Page): Promise<AxeViolationSummary[]> {
	const results = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();

	return results.violations
		.filter((v) => isGated(v.impact))
		.map((v) => ({
			id: v.id,
			impact: v.impact ?? 'unknown',
			help: v.help,
			helpUrl: v.helpUrl,
			nodes: v.nodes.length,
			targets: v.nodes.flatMap((n) => n.target.map((t) => String(t))).slice(0, 10),
		}));
}
