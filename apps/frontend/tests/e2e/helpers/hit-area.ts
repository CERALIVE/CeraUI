import type { Page } from '@playwright/test';

/** A control's painted box and the hit area it actually answers to. */
export interface HitArea {
	readonly name: string;
	readonly boxWidth: number;
	readonly boxHeight: number;
	readonly hitWidth: number;
	readonly hitHeight: number;
	readonly overlay: { top: number; bottom: number; left: number; right: number } | null;
}

/**
 * Box geometry plus the `::after` hit-area overlay's own extent, for every
 * element `selector` matches, in document order.
 *
 * The overlay is read from the pseudo's RESOLVED insets, not probed with
 * `elementFromPoint`: a control measured with a modal dialog, a sticky banner or
 * the fixed Live bar on screen would make a hit test answer about occlusion
 * rather than about the declared target. An absolutely-positioned pseudo
 * resolves its insets against the host's PADDING box, so the overlay's extent is
 * that box minus both insets on each axis; logical insets map to physical ones
 * in a left-to-right locale, which is where callers measure. A control with no
 * overlay reports `content: none`, falls through, and is measured on its box
 * alone — which is exactly the pre-fix reading a gate must be able to fail on.
 *
 * `name` is the element's test id, else its accessible label, else its text.
 */
export async function measureHitAreas(page: Page, selector: string): Promise<HitArea[]> {
	return page.evaluate((sel) => {
		const px = (value: string): number => {
			const parsed = Number.parseFloat(value);
			return Number.isFinite(parsed) ? parsed : Number.NaN;
		};
		return [...document.querySelectorAll<HTMLElement>(sel)].map((node) => {
			const rect = node.getBoundingClientRect();
			const style = getComputedStyle(node);
			const after = getComputedStyle(node, '::after');

			let overlay: { top: number; bottom: number; left: number; right: number } | null = null;
			if (after.position === 'absolute' && after.content !== 'none') {
				const top = rect.top + px(style.borderTopWidth) + px(after.insetBlockStart);
				const bottom = rect.bottom - px(style.borderBottomWidth) - px(after.insetBlockEnd);
				const left = rect.left + px(style.borderLeftWidth) + px(after.insetInlineStart);
				const right = rect.right - px(style.borderRightWidth) - px(after.insetInlineEnd);
				if ([top, bottom, left, right].every((n) => Number.isFinite(n))) {
					overlay = { top, bottom, left, right };
				}
			}

			return {
				name:
					node.dataset.testid ??
					node.getAttribute('aria-label') ??
					(node.textContent ?? '').trim().replace(/\s+/g, ' '),
				boxWidth: rect.width,
				boxHeight: rect.height,
				hitWidth: Math.max(rect.width, overlay ? overlay.right - overlay.left : 0),
				hitHeight: Math.max(rect.height, overlay ? overlay.bottom - overlay.top : 0),
				overlay,
			};
		});
	}, selector);
}
