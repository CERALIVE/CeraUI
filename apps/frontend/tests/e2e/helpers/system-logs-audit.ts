/**
 * In-page layout audit for the System Logs dialog; `auditSystemLogsPaint` covers
 * glyphs and contrast. It runs through `page.evaluate`, so it stays
 * self-contained: no imports and no closure over module scope. It probes text
 * rectangles and point hits. Failed checks add readable findings.
 */

export interface AuditInput {
	readonly locale: string;
	/** Run the touch-target size and spacing check. */
	readonly touch: boolean;
	/** Selectors whose matches replace the dialog as roots, such as an open select's listbox. */
	readonly portals?: readonly string[];
	/** Maximum tab label lines; unset records line counts without a cap. */
	readonly tabLines?: number;
}

export interface AuditResult {
	readonly found: readonly string[];
	readonly targets: readonly { readonly name: string; readonly width: number; readonly height: number }[];
	readonly tabs: readonly { readonly name: string; readonly lines: number; readonly width: number }[];
}

export function auditSystemLogs(input: AuditInput): AuditResult {
	const found: string[] = [];
	const targets: { name: string; width: number; height: number }[] = [];
	const tabs: { name: string; lines: number; width: number }[] = [];
	const dialog = document.querySelector('[data-testid="system-logs-view"]')?.closest<HTMLElement>('[role="dialog"]');
	if (!dialog) return { found: ['the System Logs dialog is not open'], targets, tabs };
	// With portals, use the matches as DOM roots in place of the dialog. The page overflow, viewport and
	// ancestor checks still apply.
	const roots: HTMLElement[] = input.portals
		? input.portals.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
		: [dialog];
	const all = (selector: string): HTMLElement[] =>
		roots.flatMap((root) => [...root.querySelectorAll<HTMLElement>(selector)]);
	const name = (el: Element): string => {
		const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
		const id = el instanceof HTMLElement ? el.dataset.testid : undefined;
		return `${id ?? el.tagName.toLowerCase()}${text === '' ? '' : ` "${text}"`}`;
	};
	const px = (value: string): number => Number.parseFloat(value) || 0;
	const shown = (el: HTMLElement): boolean => {
		const box = el.getBoundingClientRect();
		return (
			el.closest('.sr-only, [hidden]') === null &&
			box.width > 0 &&
			box.height > 0 &&
			el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
		);
	};
	const width = document.documentElement.clientWidth;
	const height = window.innerHeight;
	const scrollsY = (el: HTMLElement): boolean => /auto|scroll/.test(getComputedStyle(el).overflowY);
	// Mark clipping ancestors above a vertical scroll owner.
	const clippers = (el: HTMLElement): { box: HTMLElement; inScroll: boolean }[] => {
		const out: { box: HTMLElement; inScroll: boolean }[] = [];
		let inScroll = false;
		for (let up = el.parentElement; up !== null && up !== document.body; up = up.parentElement) {
			const style = getComputedStyle(up);
			if (style.overflowX !== 'visible' || style.overflowY !== 'visible') out.push({ box: up, inScroll });
			if (scrollsY(up)) inScroll = true;
		}
		return out;
	};
	const visible = (el: HTMLElement, rect: { top: number; bottom: number; left: number; right: number }) =>
		clippers(el).reduce(
			(area, { box }) => {
				const clip = box.getBoundingClientRect();
				return {
					top: Math.max(area.top, clip.top),
					bottom: Math.min(area.bottom, clip.bottom),
					left: Math.max(area.left, clip.left),
					right: Math.min(area.right, clip.right),
				};
			},
			{
				top: Math.max(rect.top, 0),
				bottom: Math.min(rect.bottom, height),
				left: Math.max(rect.left, 0),
				right: Math.min(rect.right, width),
			},
		);
	const textRuns = (el: HTMLElement): { text: string; parent: HTMLElement; rects: DOMRect[] }[] => {
		const runs: { text: string; parent: HTMLElement; rects: DOMRect[] }[] = [];
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
			const text = node.textContent?.trim() ?? '';
			const parent = node.parentElement;
			if (text === '' || parent === null || !shown(parent)) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			runs.push({ text, parent, rects: [...range.getClientRects()].filter((rect) => rect.width > 0) });
		}
		return runs;
	};

	// Sideways overflow.
	const doc = document.documentElement;
	if (doc.scrollWidth > doc.clientWidth) found.push(`the page scrolls sideways: ${doc.scrollWidth} > ${doc.clientWidth} px`);
	for (const el of [...roots, ...all('*')]) {
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || !shown(el)) continue;
		const style = getComputedStyle(el);
		if (style.overflowX === 'visible' || el.scrollWidth <= el.clientWidth + 1) continue;
		// Allow intentional ellipsis in raw rows.
		if (style.textOverflow === 'ellipsis' && el.closest('[data-testid="raw-row"]') !== null) continue;
		found.push(`${name(el)} overflows sideways: ${el.scrollWidth} > ${el.clientWidth} px (overflow-x ${style.overflowX})`);
	}

	const ACTIONS =
		'button, a[href], input:not([type="hidden"]), textarea, [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="combobox"], [role="option"], [tabindex="0"]';
	const STATES =
		'[data-testid="raw-follow-state"], [data-testid="raw-follow-reason"], [data-testid="system-logs-stream-pill"], [data-testid="storage-usage-text"], [data-testid="raw-anchor-approximate"], [data-testid="events-disconnected"], [data-testid="raw-disconnected"], [role="status"], [role="alert"]';
	const SEVERITY = '[data-testid="event-row"] > [role="img"], [data-testid="raw-row"] [role="img"]';
	const LABELS = 'h2, h3, [data-dialog-title]';
	const actions = all(ACTIONS).filter((el) => shown(el) && el.getAttribute('role') !== 'tabpanel' && !scrollsY(el));
	// Treat raw message and unit text as log data.
	const DATA = '[data-testid="raw-row-message"], [data-testid="raw-row-unit"]';
	const candidates = new Map<HTMLElement, string>();
	for (const el of all(LABELS).filter(shown)) candidates.set(el, 'label');
	for (const el of all(STATES).filter(shown)) candidates.set(el, 'state');
	for (const el of all(SEVERITY).filter(shown)) candidates.set(el, 'severity');
	for (const el of actions) candidates.set(el, 'action');
	const onScreen = (el: HTMLElement, x: number, y: number): boolean => {
		if (x < 0 || y < 0 || Math.round(x) >= width || Math.round(y) >= height) return false;
		const area = visible(el, { top: y, bottom: y, left: x, right: x });
		return area.top <= area.bottom && area.left <= area.right;
	};
	for (const [el, kind] of candidates) {
		const box = el.getBoundingClientRect();
		if (box.left < -0.5 || box.right > width + 0.5)
			found.push(`${kind} ${name(el)} leaves the viewport: ${box.left.toFixed(1)}-${box.right.toFixed(1)} px`);
		for (const { box: clip, inScroll } of clippers(el)) {
			const rect = clip.getBoundingClientRect();
			if (box.left < rect.left - 0.5 || box.right > rect.right + 0.5)
				found.push(`${kind} ${name(el)} is clipped sideways by ${name(clip)}`);
			if (!inScroll && !scrollsY(clip) && (box.top < rect.top - 0.5 || box.bottom > rect.bottom + 0.5))
				found.push(`${kind} ${name(el)} is clipped vertically by ${name(clip)}`);
		}
		if (kind === 'severity') continue;
		const style = getComputedStyle(el);
		const inner = {
			left: box.left + px(style.borderLeftWidth),
			right: box.right - px(style.borderRightWidth),
			top: box.top,
			bottom: box.bottom,
		};
		const passive = style.pointerEvents === 'none';
		for (const run of textRuns(el)) {
			if (run.parent.closest(DATA) !== null) continue;
			for (const rect of run.rects) {
				if (
					rect.left < inner.left - 0.5 ||
					rect.right > inner.right + 0.5 ||
					rect.top < inner.top - 1 ||
					rect.bottom > inner.bottom + 1
				)
					found.push(`${kind} ${name(el)}: "${run.text}" is painted outside its box`);
				const middle = (rect.top + rect.bottom) / 2;
				for (const x of [rect.left + 1, rect.right - 1]) {
					if (!onScreen(run.parent, x, middle)) continue;
					const hit = document.elementFromPoint(x, middle);
					let scrolledUnder: Element | null = null;
					for (let up = hit; up !== null && scrolledUnder === null; up = up.parentElement)
						if (getComputedStyle(up).position === 'sticky') scrolledUnder = up;
					const ownPaint =
						hit !== null &&
						(el.contains(hit) || (passive && hit.contains(el)) || (scrolledUnder !== null && !scrolledUnder.contains(el)));
					if (!ownPaint)
						found.push(
							`${kind} ${name(el)}: "${run.text}" is covered by ${hit === null ? 'nothing' : name(hit)} at ${x.toFixed(1)},${middle.toFixed(1)} of ${width}x${height}`,
						);
				}
			}
		}
	}

	// Tab label line count (DESIGN-FOLLOWUPS DF-21).
	for (const tab of all('[role="tab"]').filter(shown)) {
		const lines = new Set(textRuns(tab).flatMap((run) => run.rects.map((rect) => Math.round(rect.top)))).size;
		tabs.push({ name: name(tab), lines, width: tab.getBoundingClientRect().width });
		if (input.tabLines !== undefined && lines > input.tabLines) found.push(`tab ${name(tab)} wraps to ${lines} lines`);
	}

	// Touch layout: hit-area size and spacing between distinct targets.
	if (input.touch) {
		const hits = new Map<HTMLElement, { top: number; bottom: number; left: number; right: number }>();
		for (const el of actions) {
			const box = (el instanceof HTMLInputElement ? (el.closest('label') ?? el) : el).getBoundingClientRect();
			const style = getComputedStyle(el);
			const after = getComputedStyle(el, '::after');
			let hit = { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
			if (after.position === 'absolute' && after.content !== 'none') {
				const overlay = {
					top: box.top + px(style.borderTopWidth) + px(after.insetBlockStart),
					bottom: box.bottom - px(style.borderBottomWidth) - px(after.insetBlockEnd),
					left: box.left + px(style.borderLeftWidth) + px(after.insetInlineStart),
					right: box.right - px(style.borderRightWidth) - px(after.insetInlineEnd),
				};
				hit = {
					top: Math.min(hit.top, overlay.top),
					bottom: Math.max(hit.bottom, overlay.bottom),
					left: Math.min(hit.left, overlay.left),
					right: Math.max(hit.right, overlay.right),
				};
			}
			hits.set(el, hit);
			const w = hit.right - hit.left;
			const h = hit.bottom - hit.top;
			targets.push({ name: name(el), width: w, height: h });
			if (w < 43.5 || h < 43.5) found.push(`target ${name(el)} is ${w.toFixed(1)} x ${h.toFixed(1)} px, under 44 x 44`);
		}
		const entries = [...hits];
		for (let i = 0; i < entries.length; i++) {
			for (let j = i + 1; j < entries.length; j++) {
				const [a, x] = entries[i] ?? [];
				const [b, y] = entries[j] ?? [];
				if (!a || !b || !x || !y) continue;
				if (a.contains(b) || b.contains(a)) continue;
				const group = (el: HTMLElement) => el.closest('[role="radiogroup"], [role="listbox"], [data-testid="raw-list"], [data-testid="boot-picker"]');
				if (group(a) !== null && group(a) === group(b)) continue;
				const nested = (outer: typeof x, inner: typeof y) =>
					inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;
				if (nested(x, y) || nested(y, x)) continue;
				const p = visible(a, x);
				const q = visible(b, y);
				const whole = (seen: typeof p, hit: typeof x) =>
					seen.bottom - seen.top >= hit.bottom - hit.top - 0.5 && seen.right - seen.left >= hit.right - hit.left - 0.5;
				if (!whole(p, x) || !whole(q, y)) continue;
				const across = Math.max(p.left, q.left) - Math.min(p.right, q.right);
				const down = Math.max(p.top, q.top) - Math.min(p.bottom, q.bottom);
				const gap = Math.max(across, down);
				if (gap < 7.5) found.push(`${name(a)} and ${name(b)} are ${gap.toFixed(1)} px apart, under 8`);
			}
		}
	}

	// CJK words split across lines.
	if (['ja', 'ko', 'zh'].includes(input.locale)) {
		const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
		const segmenter = new Intl.Segmenter(input.locale, { granularity: 'word' });
		for (const root of roots) {
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
				const parent = node.parentElement;
				if (parent === null || !shown(parent) || parent.closest('[dir="ltr"]:not(html)') !== null) continue;
				for (const part of segmenter.segment(node.textContent ?? '')) {
					if (!part.isWordLike || [...part.segment].length < 2 || !cjk.test(part.segment)) continue;
					const range = document.createRange();
					range.setStart(node, part.index);
					range.setEnd(node, part.index + part.segment.length);
					const lines = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
					if (lines.size > 1) found.push(`"${part.segment}" splits across lines in ${name(parent)}`);
				}
			}
		}
	}
	return { found, targets, tabs };
}
