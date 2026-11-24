import { expect, type Locator } from '@playwright/test';

interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface TextFit {
	text: string;
	lines: number;
	naturalWidth: number;
	slot: Box;
	escaped: Box[];
	lastWord: Box | null;
	clipped: string[];
	crowded: string[];
	pageOverflowX: number;
}

/**
 * Measure a painted sentence against the box that shows it.
 *
 * A visibility or text assertion passes for an ellipsized element, because the
 * DOM still holds the whole sentence. What the operator reads are the text's
 * line boxes (`Range` rects), so those are compared with the text's box, the
 * row hosting it and the viewport, with 1 px for sub-pixel layout. The row's
 * direct children are its cells: the icon, the text column, the control.
 */
export async function probeTextFit(text: Locator, row: Locator): Promise<TextFit> {
	const rowHandle = await row.elementHandle();
	if (rowHandle === null) throw new Error('probeTextFit: the row is not attached');
	return text.evaluate((el, rowEl) => {
		if (!(rowEl instanceof HTMLElement) || !rowEl.contains(el)) {
			throw new Error('probeTextFit: the text is not inside its row');
		}
		const TOLERANCE = 1;
		const box = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
		const inside = (a: Box, b: Box) =>
			a.left >= b.left - TOLERANCE &&
			a.right <= b.right + TOLERANCE &&
			a.top >= b.top - TOLERANCE &&
			a.bottom <= b.bottom + TOLERANCE;
		const overlap = (a: Box, b: Box) =>
			a.left < b.right - TOLERANCE &&
			b.left < a.right - TOLERANCE &&
			a.top < b.bottom - TOLERANCE &&
			b.top < a.bottom - TOLERANCE;
		const name = (node: Element) =>
			`${node.tagName.toLowerCase()}${node instanceof HTMLElement && node.dataset.testid ? `[${node.dataset.testid}]` : ''}`;

		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			if (node.data.trim() !== '') nodes.push(node);
		}
		const range = document.createRange();
		const rects = nodes.flatMap((node) => {
			range.selectNodeContents(node);
			return [...range.getClientRects()].filter((r) => r.width > 0).map(box);
		});
		const lineTops: number[] = [];
		for (const r of rects) {
			if (!lineTops.some((top) => Math.abs(top - r.top) < (r.bottom - r.top) / 2)) lineTops.push(r.top);
		}

		const last = nodes.at(-1);
		let lastWord: Box | null = null;
		if (last !== undefined) {
			const end = last.data.trimEnd().length;
			range.setStart(last, last.data.trimEnd().lastIndexOf(' ') + 1);
			range.setEnd(last, end);
			lastWord = box(range.getBoundingClientRect());
		}

		const slot = box(el.getBoundingClientRect());
		const host = box(rowEl.getBoundingClientRect());
		const viewport = document.documentElement.clientWidth;
		const escaped = rects.filter(
			(r) => !inside(r, slot) || !inside(r, host) || r.left < -TOLERANCE || r.right > viewport + TOLERANCE,
		);

		const clipped: string[] = [];
		for (let node: Element | null = el; node !== null; node = node.parentElement) {
			const style = getComputedStyle(node);
			if (style.display !== 'inline' && (style.overflowX !== 'visible' || style.overflowY !== 'visible')) {
				const wide = node.scrollWidth - node.clientWidth;
				const tall = node.scrollHeight - node.clientHeight;
				if (wide > TOLERANCE || tall > TOLERANCE) clipped.push(`${name(node)} +${wide}x+${tall}`);
			}
			if (node === rowEl) break;
		}

		const cells = [...rowEl.children].filter((cell) => {
			const r = cell.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		});
		const textCell = cells.find((cell) => cell.contains(el));
		const crowded: string[] = [];
		for (const cell of cells) {
			const r = box(cell.getBoundingClientRect());
			if (!inside(r, host)) crowded.push(`${name(cell)} leaves the row`);
			if (textCell && cell !== textCell && overlap(r, box(textCell.getBoundingClientRect()))) {
				crowded.push(`${name(cell)} overlaps the text`);
			}
		}

		return {
			text: el.textContent?.trim() ?? '',
			lines: lineTops.length,
			naturalWidth: rects.reduce((sum, r) => sum + (r.right - r.left), 0),
			slot,
			escaped,
			lastWord,
			clipped,
			crowded,
			pageOverflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
		};
	}, rowHandle);
}

export function expectTextFits(fit: TextFit, label: string): void {
	const detail = `${label}: ${JSON.stringify(fit)}`;
	expect(fit.lines, detail).toBeGreaterThan(0);
	expect(fit.escaped, detail).toEqual([]);
	expect(fit.clipped, detail).toEqual([]);
	expect(fit.crowded, detail).toEqual([]);
	expect(fit.pageOverflowX, detail).toBe(0);
}
