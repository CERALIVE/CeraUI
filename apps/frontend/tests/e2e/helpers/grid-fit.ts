import { expect, type Locator } from '@playwright/test';

/** One cell of a dense readout as drawn. */
export interface CellFit {
	text: string;
	/** How far any rendered text line reaches past the cell's padded inline edges. */
	spill: number;
	/** How far the cell or its text reaches past the readout's own padded box. */
	rowSpill: number;
	/** How far the cell or its text reaches past the enclosing card, when one is given. */
	cardSpill: number;
	/** Descendants that cut their own text off: an ellipsis, a line clamp, a hidden overflow. */
	clipped: string[];
	/** Text drawn on more lines than it has words, so it broke inside a word. */
	brokenWords: string[];
	smallestFontPx: number;
}

export interface GridFit {
	/** Track count of a grid; 0 for a row of cells that is not a grid. */
	columns: number;
	cells: CellFit[];
}

/**
 * Read a grid (or a row) of cells as drawn: each direct child is a cell, and its
 * text is measured by its `Range` line boxes, which is what the operator reads.
 * Each line box is held to its cell, to the readout itself, and to `card` when
 * given, because a cell that keeps its own text can still leave the row.
 *
 * The page settles first (fonts, the frame a resize schedules, every finite
 * running animation) and only then are the elements resolved and measured in one
 * synchronous pass: a resize can swap a dialog for a sheet and remount its body,
 * and an element held across that swap would be measured detached.
 */
export async function readGridFit(grid: Locator, card?: Locator): Promise<GridFit> {
	await grid.page().evaluate(async () => {
		await document.fonts.ready;
		const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		await frame();
		for (;;) {
			const running = document
				.getAnimations()
				.filter((animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity);
			if (running.length === 0) break;
			await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
			await frame();
		}
	});
	await expect(grid).toBeVisible();
	await expect.poll(async () => (await grid.boundingBox())?.width ?? 0).toBeGreaterThan(0);
	const cardHandle = card ? await card.elementHandle() : null;
	return grid.evaluate((root, cardEl) => {
		if (!root.isConnected || (cardEl instanceof Element && !cardEl.isConnected)) {
			throw new Error('readGridFit: the readout was replaced while it was being measured');
		}
		const px = (value: string) => Number.parseFloat(value) || 0;
		const paddedBox = (el: Element) => {
			const box = el.getBoundingClientRect();
			const style = getComputedStyle(el);
			return {
				left: box.left + px(style.borderLeftWidth) + px(style.paddingLeft),
				right: box.right - px(style.borderRightWidth) - px(style.paddingRight),
			};
		};
		const beyond = (rects: DOMRect[], edge: { left: number; right: number }) =>
			Math.max(0, ...rects.map((rect) => Math.max(edge.left - rect.left, rect.right - edge.right)));
		const rowEdge = paddedBox(root);
		const cardEdge = cardEl instanceof Element ? paddedBox(cardEl) : null;
		const style = getComputedStyle(root);
		const range = new Range();
		const cells = [...root.children].map((cell) => {
			const cellEdge = paddedBox(cell);
			let smallestFontPx = Number.POSITIVE_INFINITY;
			const brokenWords: string[] = [];
			const lineBoxes: DOMRect[] = [];
			const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				if (!(node instanceof Text) || !node.data.trim() || !node.parentElement) continue;
				smallestFontPx = Math.min(smallestFontPx, px(getComputedStyle(node.parentElement).fontSize));
				range.selectNodeContents(node);
				const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
				lineBoxes.push(...lines);
				const words = node.data.trim().split(/\s+/).length;
				if (new Set(lines.map((rect) => Math.round(rect.top))).size > words) brokenWords.push(node.data.trim());
			}
			const own = [cell.getBoundingClientRect(), ...lineBoxes];
			const clipped = [cell, ...cell.querySelectorAll('*')]
				.filter((el): el is HTMLElement => el instanceof HTMLElement)
				.filter((el) => {
					const elStyle = getComputedStyle(el);
					return (
						(elStyle.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) ||
						(elStyle.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1)
					);
				})
				.map((el) => (el.textContent ?? '').trim());
			return {
				text: (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
				spill: beyond(lineBoxes, cellEdge),
				rowSpill: beyond(own, rowEdge),
				cardSpill: cardEdge ? beyond(own, cardEdge) : 0,
				clipped,
				brokenWords,
				smallestFontPx: Number.isFinite(smallestFontPx) ? smallestFontPx : 0,
			};
		});
		const columns = style.display === 'grid' ? style.gridTemplateColumns.split(' ').length : 0;
		return { columns, cells };
	}, cardHandle);
}

/** Every way a readout breaks the fit rule, as readable lines; empty when it fits. */
export function gridFitProblems(
	where: string,
	fit: GridFit,
	{ columns, minFontPx, wordsMayBreak = false }: { columns?: number; minFontPx?: number; wordsMayBreak?: boolean } = {},
): string[] {
	const problems: string[] = [];
	if (columns !== undefined && fit.columns !== columns) {
		problems.push(`${where}: ${fit.columns} columns, expected ${columns}`);
	}
	for (const cell of fit.cells) {
		const name = `"${cell.text.slice(0, 48)}"`;
		if (cell.spill > 0.5) problems.push(`${where}: ${name} reaches ${cell.spill.toFixed(1)} px past its cell`);
		if (cell.rowSpill > 0.5) problems.push(`${where}: ${name} reaches ${cell.rowSpill.toFixed(1)} px past its row`);
		if (cell.cardSpill > 0.5) problems.push(`${where}: ${name} reaches ${cell.cardSpill.toFixed(1)} px past its card`);
		for (const text of cell.clipped) problems.push(`${where}: ${name} clips "${text.slice(0, 48)}"`);
		if (!wordsMayBreak) {
			for (const text of cell.brokenWords) problems.push(`${where}: ${name} breaks inside a word: "${text.slice(0, 48)}"`);
		}
		if (minFontPx !== undefined && cell.text && cell.smallestFontPx < minFontPx) {
			problems.push(`${where}: ${name} is ${cell.smallestFontPx} px, below ${minFontPx} px`);
		}
	}
	return problems;
}
