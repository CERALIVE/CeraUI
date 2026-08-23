import { expect, type Page } from '@playwright/test';

/**
 * The ONE `DESIGN.md` §4/§5 containment probe for the modem surfaces.
 *
 * Extracted verbatim from `modem-a11y.spec.ts` (UI pass 3) when pass 4 needed to
 * re-measure the same contract while capturing evidence. It lives here rather
 * than being copied because pass 3 already established the rule this file
 * embodies: a rule that exists twice is a rule that can disagree with itself,
 * and a confirming pass that measured a *different* containment rule from the
 * one it is confirming would prove nothing.
 *
 * Nothing about the measurement changed in the move.
 */

/** `DESIGN.md` §4 — the three mandatory verification widths, plus the kiosk case. */
export const KIOSK_VIEWPORT = { width: 1024, height: 600 } as const;

export const MANDATORY_BREAKPOINTS = [
	{ width: 375, height: 812 },
	{ width: 768, height: 1024 },
	{ width: 1280, height: 800 },
	KIOSK_VIEWPORT,
] as const;

export type ContainmentReport = {
	documentOverflowPx: number;
	overflowSources: string[];
	rows: number;
	rowsEscapingSection: string[];
	contentEscapingRow: string[];
	clipped: string[];
	dottedKeys: string[];
};

/**
 * Measure the whole `DESIGN.md` §4/§5 containment contract in ONE round trip.
 *
 * One evaluate, not one per assertion: per-locator `boundingBox()` calls
 * interleave with layout, so a reflow between reads can produce a verdict for a
 * layout that never existed on screen at once. It is also the reason every leg
 * shares THIS probe rather than growing a per-locale copy.
 */
export async function probeContainment(page: Page): Promise<ContainmentReport> {
	await settleDestination(page);

	return page.evaluate(() => {
		// BP-2 gates STATE, SIGNAL and ACTION. The device name and the hardware
		// tags are the demoted tier (§2) and MAY truncate, so they are absent here
		// on purpose — `modem-name` carries `truncate` by design.
		//
		// `modem-class-badge` is the one demoted-tier element that IS gated, and
		// it is here because todo 29 rewrote its copy: it now carries a translated
		// SENTENCE FRAGMENT (`Gerenciado diretamente`, `Gestionado directamente`)
		// where it used to carry a wire token, and a clipped badge reads as a
		// different word rather than as an obviously-truncated one. It lives in
		// the row's disclosure, so `laidOut()` skips it until a caller has opened
		// that disclosure (see `openRowDisclosures`) — which makes adding it here
		// inert for every leg that does not.
		const GATED = [
			'modem-state-badge',
			'modem-carrier-badge',
			'modem-roaming-badge',
			'modem-class-badge',
			'modem-signal',
			'modem-router-signal',
			'modem-details-toggle',
			'open-modem-config-dialog',
			'open-modem-unlock-dialog',
			'open-router-admin',
		];
		// A rendered dotted path is a MISSING catalog entry (LO-1). Anchored on the
		// namespaces these surfaces actually use, so a device-reported value that
		// merely contains a dot (an IP, a firmware revision) cannot false-positive.
		const DOTTED_KEY_RE =
			/\b(?:network|settings|live|hud|advanced|connection|a11y)(?:\.[a-z][a-zA-Z0-9_]*){2,}\b/g;

		const laidOut = (el: Element): boolean => {
			const node = el as HTMLElement;
			if (node.offsetParent === null) return false;
			return getComputedStyle(node).visibility !== 'hidden';
		};
		const describe = (el: Element): string =>
			el.getAttribute('data-testid') ?? el.tagName;

		const doc = document.documentElement;
		const section = document.querySelector(
			'section:has([data-testid="modem-row"])',
		);
		const rows = [...document.querySelectorAll('[data-testid="modem-row"]')];

		const rowsEscapingSection: string[] = [];
		if (section) {
			const outer = section.getBoundingClientRect();
			for (const row of rows) {
				const inner = row.getBoundingClientRect();
				if (inner.left < outer.left - 1 || inner.right > outer.right + 1) {
					rowsEscapingSection.push(
						`${row.getAttribute('data-modem-id')} (${Math.round(inner.left)}..${Math.round(inner.right)} vs ${Math.round(outer.left)}..${Math.round(outer.right)})`,
					);
				}
			}
		}

		const contentEscapingRow: string[] = [];
		const clipped: string[] = [];
		for (const row of rows) {
			const outer = row.getBoundingClientRect();
			for (const child of row.querySelectorAll('[data-testid]')) {
				if (!laidOut(child)) continue;
				const inner = child.getBoundingClientRect();
				if (inner.width === 0) continue;
				if (inner.left < outer.left - 1 || inner.right > outer.right + 1) {
					contentEscapingRow.push(
						`${describe(child)} (${Math.round(inner.left)}..${Math.round(inner.right)} vs ${Math.round(outer.left)}..${Math.round(outer.right)})`,
					);
				}
				const testid = child.getAttribute('data-testid') ?? '';
				if (!GATED.some((id) => testid === id || testid.startsWith(`${id}-`)))
					continue;
				const node = child as HTMLElement;
				if (node.scrollWidth > node.clientWidth + 1) {
					clipped.push(`${testid} (${node.scrollWidth} > ${node.clientWidth})`);
				}
			}
		}

		const dottedKeys = [
			...new Set((section?.textContent ?? '').match(DOTTED_KEY_RE) ?? []),
		].sort();

		// A document-level overflow names no culprit on its own, and a bare "the
		// page is 264px too wide" is the kind of failure that gets re-diagnosed by
		// hand every time. Report the DEEPEST offenders — an ancestor is only wide
		// because a descendant made it so, so the leaves are the actionable ones.
		const limit = doc.clientWidth;
		const overflowing = [...document.querySelectorAll('body *')].filter((el) => {
			const node = el as HTMLElement;
			if (node.offsetParent === null) return false;
			if (getComputedStyle(node).visibility === 'hidden') return false;
			const rect = node.getBoundingClientRect();
			return rect.width > 0 && rect.right > limit + 1;
		});
		const describeBox = (el: Element): string => {
			const rect = el.getBoundingClientRect();
			const name =
				el.getAttribute('data-testid') ?? el.getAttribute('class') ?? el.tagName;
			const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
			return `${name} w=${Math.round(rect.width)} right=${Math.round(rect.right)} "${text}"`;
		};
		const leaves = overflowing.filter(
			(el) => !overflowing.some((other) => other !== el && el.contains(other)),
		);
		const overflowSources = leaves
			.slice(0, 8)
			.map((el) => `${describeBox(el)} (limit ${limit})`);
		// The widest leaf is only wide because an ancestor let it be, so the chain
		// above it is where the fix goes. Reported for the worst offender only —
		// enough to name the container, short enough to stay readable in a failure.
		const worst = [...leaves].sort(
			(a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right,
		)[0];
		if (worst !== undefined) {
			overflowSources.push(
				`--- ancestry of the widest (viewport ${window.innerWidth}) ---`,
			);
			let node: HTMLElement | null = worst as HTMLElement;
			while (node !== null && node !== document.documentElement) {
				overflowSources.push(`  ${describeBox(node)}`);
				node = node.parentElement;
			}
		}

		return {
			documentOverflowPx: doc.scrollWidth - doc.clientWidth,
			overflowSources,
			rows: rows.length,
			rowsEscapingSection,
			contentEscapingRow,
			clipped,
			dottedKeys,
		};
	});
}

/**
 * Wait until the destination has ARRIVED and every finite animation has drained.
 *
 * `NavigationRenderer` flies the destination in, so a probe — or a screenshot —
 * taken right after `navigateTo` catches `destination-content` translated ~287px
 * and reports the entire page as overflowing: a defect that exists for a few
 * frames and belongs to nothing.
 *
 * Waiting on `getAnimations()` alone does NOT cover it. That `in:fly` carries a
 * `delay`, and Svelte registers the animation after the element is already in the
 * DOM at its translated start, so an early snapshot sees an empty set and waits
 * for nothing. The arrival is therefore asserted from the RENDERED position — the
 * element sitting on its container's edge — and only then is the remaining
 * animation set drained. Infinite animations (the skeleton pulses) are excluded
 * there because they never settle by design.
 */
export async function settleDestination(page: Page): Promise<void> {
	await page.waitForFunction(
		() => {
			const nodes = document.querySelectorAll(
				'[data-testid="destination-content"]',
			);
			const el = nodes.length === 1 ? nodes[0] : null;
			const parent = el?.parentElement;
			if (el === null || !parent) return false;
			return (
				Math.abs(
					el.getBoundingClientRect().left - parent.getBoundingClientRect().left,
				) <= 1
			);
		},
		undefined,
		{ timeout: 15_000 },
	);
	await page.evaluate(async () => {
		const settling = document.getAnimations().filter((animation) => {
			const timing = animation.effect?.getComputedTiming();
			return timing !== undefined && timing.iterations !== Number.POSITIVE_INFINITY;
		});
		await Promise.all(
			settling.map((animation) => animation.finished.catch(() => undefined)),
		);
	});
}

/**
 * Open every modem row's per-row disclosure, and wait for the reveal to settle.
 *
 * The disclosure keeps its body MOUNTED and clips it with `overflow: hidden` +
 * `visibility: hidden`, so its content has NO measurable geometry while
 * collapsed — `probeContainment`'s `laidOut()` filter skips it, correctly and
 * silently. Anything that only exists down there (the class badge, the detail
 * line, the router fact strip) is therefore unmeasured until a caller opens it,
 * which is what this does.
 *
 * Both waits are load-bearing. The reveal is a 200 ms CSS transition on
 * `grid-template-rows` AND on `visibility`, so a probe taken on the click's own
 * turn measures a track that is still 0fr; and `data-open` flips synchronously
 * while the transition has not started, so waiting on the attribute alone is not
 * enough either. The attribute settles the STATE and `getAnimations()` settles
 * the GEOMETRY.
 */
export async function openRowDisclosures(page: Page): Promise<number> {
	const toggles = page.getByTestId('modem-details-toggle');
	const count = await toggles.count();
	for (let i = 0; i < count; i++) {
		const toggle = toggles.nth(i);
		if ((await toggle.getAttribute('aria-expanded')) === 'true') continue;
		await toggle.click();
	}
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll('[data-testid="modem-details-body"]')].every(
				(el) => el.getAttribute('data-open') === 'true',
			),
		undefined,
		{ timeout: 15_000 },
	);
	await page.evaluate(async () => {
		await Promise.all(
			document
				.getAnimations()
				.filter(
					(animation) =>
						animation.effect?.getComputedTiming().iterations !==
						Number.POSITIVE_INFINITY,
				)
				.map((animation) => animation.finished.catch(() => undefined)),
		);
	});
	return count;
}

export type FoldReport = {
	missing: string[];
	/** Scrollable ancestors already scrolled — the probe's own vacuity guard. */
	preScrolled: string[];
	/** `testid (Npx above|below the fold)` for anything not fully on screen. */
	offscreen: string[];
};

/**
 * Is each of these reachable WITHOUT scrolling?
 *
 * The gap todo 35 recorded with F4: `probeContainment` measures the horizontal
 * contract and `probeDialogOverflow` asks whether content escapes the dialog
 * BOX — nothing asked whether a surface's primary action is on screen when the
 * operator arrives. On the shipped 1024x600 kiosk the dongle login's heading was
 * clipped at the bottom edge and `locked-out`'s wait was fully below it, and
 * every existing gate stayed green.
 *
 * Three measurement rules are load-bearing:
 *
 *  1. **Nothing is scrolled first.** Playwright's own visibility check and every
 *     `boundingBox()` helper will happily scroll an element into view, which
 *     answers a different question. `preScrolled` reports any scrollable
 *     ancestor already offset, so a caller cannot accidentally measure a
 *     surface some earlier step had scrolled — an empty `offscreen` on a
 *     scrolled surface would be the vacuous pass.
 *  2. **The fold is an INTERSECTION, not the viewport.** A dialog body is its
 *     own scroll container, so an element can sit inside the viewport and still
 *     be clipped by the panel it lives in. The visible band is the viewport
 *     narrowed by every clipping ancestor.
 *  3. **Partly visible is offscreen.** A heading clipped mid-glyph is exactly
 *     the F4 symptom, so the whole box must be inside the band; the report names
 *     the direction and the number of pixels so a failure is actionable without
 *     re-measuring by hand.
 */
export async function probeFold(
	page: Page,
	testids: readonly string[],
): Promise<FoldReport> {
	return page.evaluate((ids) => {
		const SCROLLED = /auto|scroll/;
		const CLIPPED = /auto|scroll|hidden|clip/;
		const missing: string[] = [];
		const preScrolled: string[] = [];
		const offscreen: string[] = [];

		for (const id of ids) {
			const el = document.querySelector<HTMLElement>(
				`[data-testid="${id}"]`,
			);
			if (el === null) {
				missing.push(id);
				continue;
			}

			let top = 0;
			let bottom = window.innerHeight;
			for (
				let node: HTMLElement | null = el.parentElement;
				node !== null;
				node = node.parentElement
			) {
				const style = getComputedStyle(node);
				const overflow = `${style.overflowY} ${style.overflow}`;
				if (SCROLLED.test(overflow) && node.scrollTop > 1) {
					preScrolled.push(
						`${id}: ancestor ${node.getAttribute("data-testid") ?? node.tagName} is scrolled ${Math.round(node.scrollTop)}px`,
					);
				}
				if (!CLIPPED.test(overflow)) continue;
				const box = node.getBoundingClientRect();
				top = Math.max(top, box.top);
				bottom = Math.min(bottom, box.bottom);
			}

			const rect = el.getBoundingClientRect();
			const above = Math.round(top - rect.top);
			const below = Math.round(rect.bottom - bottom);
			if (above > 1) offscreen.push(`${id} (${above}px above the fold)`);
			else if (below > 1) offscreen.push(`${id} (${below}px below the fold)`);
		}

		return { missing, preScrolled, offscreen };
	}, testids);
}

/** Assert one measured surface: every named element is on screen, unscrolled. */
export function expectReachableWithoutScrolling(
	report: FoldReport,
	label: string,
): void {
	expect(
		report.missing,
		`${label}: element(s) never rendered: ${report.missing.join(", ")}`,
	).toEqual([]);
	expect(
		report.preScrolled,
		`${label}: the surface was already scrolled, so "without scrolling" was never measured:\n${report.preScrolled.join("\n")}`,
	).toEqual([]);
	expect(
		report.offscreen,
		`${label}: the operator must scroll to reach:\n${report.offscreen.join("\n")}`,
	).toEqual([]);
}

/** Test-ids of dialog content laid out outside the dialog's own box. */
export function probeDialogOverflow(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const surface = document.querySelector('[role="dialog"]');
		if (!surface) return ['no dialog'];
		const outer = surface.getBoundingClientRect();
		const out: string[] = [];
		for (const child of surface.querySelectorAll('[data-testid]')) {
			const el = child as HTMLElement;
			if (el.offsetParent === null) continue;
			if (getComputedStyle(el).visibility === 'hidden') continue;
			const inner = el.getBoundingClientRect();
			if (inner.width === 0) continue;
			if (inner.left < outer.left - 1 || inner.right > outer.right + 1) {
				out.push(String(el.getAttribute('data-testid')));
			}
		}
		return out;
	});
}

/** Assert one measured viewport against BP-1, BP-2, LO-1 and LO-5. */
export function expectContained(report: ContainmentReport, label: string): void {
	expect(
		report.documentOverflowPx,
		`${label}: the document overflows horizontally by ${report.documentOverflowPx}px. Widest offenders:\n${report.overflowSources.join('\n')}`,
	).toBeLessThanOrEqual(1);
	expect(report.rows, `${label}: rows must be laid out`).toBeGreaterThan(0);
	expect(
		report.rowsEscapingSection,
		`${label}: modem row(s) overflow the cellular section:\n${report.rowsEscapingSection.join('\n')}`,
	).toEqual([]);
	expect(
		report.contentEscapingRow,
		`${label}: row content escapes its row:\n${report.contentEscapingRow.join('\n')}`,
	).toEqual([]);
	expect(
		report.clipped,
		`${label}: state/signal/action clipped to unreadability:\n${report.clipped.join('\n')}`,
	).toEqual([]);
	expect(
		report.dottedKeys,
		`${label}: unresolved i18n key(s) rendered: ${report.dottedKeys.join(', ')}`,
	).toEqual([]);
}
