/**
 * In-page glyph and contrast audit for System Logs. It runs through
 * `page.evaluate`, so it stays self-contained. The contrast compositor uses colour alpha and does not model
 * CSS opacity, gradients, images or overlapping paint.
 */

export interface PaintInput {
	/** Selectors whose matches replace the dialog as roots, such as an open select's listbox. */
	readonly portals?: readonly string[];
}

export interface PaintResult {
	readonly found: readonly string[];
	readonly fonts: readonly { readonly text: string; readonly family: string }[];
	readonly contrast: readonly { readonly name: string; readonly ratio: number }[];
}

export function auditSystemLogsPaint(input: PaintInput): PaintResult {
	const found: string[] = [];
	const fonts: { text: string; family: string }[] = [];
	const contrast: { name: string; ratio: number }[] = [];
	const dialog = document.querySelector('[data-testid="system-logs-view"]')?.closest<HTMLElement>('[role="dialog"]');
	if (!dialog) return { found: ['the System Logs dialog is not open'], fonts, contrast };
	const roots: HTMLElement[] = input.portals
		? input.portals.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)])
		: [dialog];
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
	const canvas = document.createElement('canvas');
	canvas.width = 96;
	canvas.height = 96;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (ctx === null) throw new Error('Chromium gave no 2D canvas context');
	const glyph = (font: string, char: string): string => {
		ctx.clearRect(0, 0, 96, 96);
		ctx.font = font;
		ctx.textBaseline = 'top';
		ctx.fillStyle = '#000';
		ctx.fillText(char, 8, 8);
		return ctx.getImageData(0, 0, 96, 96).data.filter((_, i) => i % 4 === 3).join(',');
	};
	const rgba = (color: string) => {
		ctx.clearRect(0, 0, 1, 1);
		ctx.fillStyle = color;
		ctx.fillRect(0, 0, 1, 1);
		const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
		return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
	};
	type Rgba = ReturnType<typeof rgba>;
	const over = (top: Rgba, bottom: Rgba): Rgba => ({
		r: top.r * top.a + bottom.r * (1 - top.a),
		g: top.g * top.a + bottom.g * (1 - top.a),
		b: top.b * top.a + bottom.b * (1 - top.a),
		a: 1,
	});
	const luminance = (color: Rgba): number => {
		const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
		return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
	};
	const backdrop = (el: HTMLElement): Rgba => {
		const chain: HTMLElement[] = [];
		for (let up: HTMLElement | null = el; up !== null; up = up.parentElement) chain.unshift(up);
		return chain.reduce((below, node) => over(rgba(getComputedStyle(node).backgroundColor), below), {
			r: 1,
			g: 1,
			b: 1,
			a: 1,
		});
	};
	const ratio = (fg: Rgba, bg: Rgba): number => {
		const a = luminance(over(fg, bg));
		const b = luminance(bg);
		return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	};
	const missing = new Map<string, string>();
	const checked = new Set<string>();
	for (const el of roots.flatMap((root) => [...root.querySelectorAll<HTMLElement>('*')]).filter(shown)) {
		const own = [...el.childNodes]
			.filter((node) => node.nodeType === Node.TEXT_NODE)
			.map((node) => node.textContent ?? '')
			.join('')
			.trim();
		const style = getComputedStyle(el);
		const placeholder = el instanceof HTMLInputElement && el.value === '' ? el.placeholder : '';
		if (own === '' && placeholder === '') continue;
		const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
		const box = missing.get(font) ?? glyph(font, '\u{10FFFD}');
		missing.set(font, box);
		for (const char of new Set(
			[...(own + placeholder)].filter((c) => /[^\s\u0000-\u007f]/u.test(c) && !/\p{Default_Ignorable_Code_Point}/u.test(c)),
		)) {
			const key = `${font}|${char}`;
			if (checked.has(key)) continue;
			checked.add(key);
			const painted = glyph(font, char);
			if (painted === box || !/[1-9]/.test(painted))
				found.push(`"${char}" renders as a missing glyph in ${name(el)} (${style.fontFamily})`);
		}
		if (fonts.length < 3 && /[^\u0000-\u007f]/u.test(own)) fonts.push({ text: own.slice(0, 24), family: style.fontFamily });
		if (el.closest('[disabled], [aria-disabled="true"], [data-disabled]') !== null) continue;
		const bg = backdrop(el);
		const size = px(style.fontSize);
		const large = size >= 24 || (size >= 18.66 && px(style.fontWeight) >= 700);
		const measure = (label: string, color: string) => {
			const value = ratio(rgba(color), bg);
			contrast.push({ name: label, ratio: Number(value.toFixed(2)) });
			if (value < (large ? 3 : 4.5)) found.push(`${label} contrast ${value.toFixed(2)}:1 under ${large ? 3 : 4.5}:1`);
		};
		if (own !== '') measure(name(el), style.color);
		if (placeholder !== '') measure(`placeholder of ${name(el)}`, getComputedStyle(el, '::placeholder').color);
	}
	return { found, fonts, contrast };
}
