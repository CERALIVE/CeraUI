import {
	COMPOSITION_RECT_MIN,
	type CompositionLayout,
	type CompositionRect,
} from "@ceraui/rpc/schemas";

/**
 * Geometry for the second picture input, in fractions of the output frame.
 *
 * Every rectangle these helpers return is one the engine accepts
 * (`compositionRectFits`): the arithmetic runs in whole ten-thousandths of the
 * frame, so many small steps never drift a side past the edge by a rounding
 * error the engine would refuse.
 */

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const CORNERS: readonly Corner[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
];

export type Box = { x: number; y: number; width: number; height: number };

const UNIT = 10_000;
const MIN = Math.round(COMPOSITION_RECT_MIN * UNIT);

const units = (value: number) => Math.round(value * UNIT);
const clamp = (value: number, low: number, high: number) =>
	Math.min(Math.max(value, low), high);
const fromUnits = (x: number, y: number, width: number, height: number) => ({
	x: x / UNIT,
	y: y / UNIT,
	width: width / UNIT,
	height: height / UNIT,
});

/** Where the compositor puts the second input for a preset: half of each axis, a 5% margin for the insets. */
export function presetRect(
	layout: Exclude<CompositionLayout, "custom">,
): CompositionRect {
	const half = UNIT / 2;
	const margin = UNIT / 20;
	switch (layout) {
		case "pip-top-right":
			return fromUnits(UNIT - margin - half, margin, half, half);
		case "pip-top-left":
			return fromUnits(margin, margin, half, half);
		case "pip-bottom-right":
			return fromUnits(UNIT - margin - half, UNIT - margin - half, half, half);
		case "pip-bottom-left":
			return fromUnits(margin, UNIT - margin - half, half, half);
		case "pbp-left-right":
			return fromUnits(half, 0, UNIT - half, UNIT);
		case "pbp-top-bottom":
			return fromUnits(0, half, UNIT, UNIT - half);
	}
}

/** Inside the frame, each side at least `COMPOSITION_RECT_MIN`; a fitting rectangle is returned unchanged. */
export function clampRect(rect: CompositionRect): CompositionRect {
	const width = clamp(units(rect.width), MIN, UNIT);
	const height = clamp(units(rect.height), MIN, UNIT);
	return fromUnits(
		clamp(units(rect.x), 0, UNIT - width),
		clamp(units(rect.y), 0, UNIT - height),
		width,
		height,
	);
}

export function moveRect(
	rect: CompositionRect,
	dx: number,
	dy: number,
): CompositionRect {
	return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/** Drags one corner by (dx, dy); the opposite corner stays where it is. */
export function resizeRect(
	rect: CompositionRect,
	corner: Corner,
	dx: number,
	dy: number,
): CompositionRect {
	const { x, y, width, height } = clampRect(rect);
	let [left, top] = [units(x), units(y)];
	let [right, bottom] = [left + units(width), top + units(height)];
	if (corner.endsWith("left")) left = clamp(left + units(dx), 0, right - MIN);
	else right = clamp(right + units(dx), left + MIN, UNIT);
	if (corner.startsWith("top")) top = clamp(top + units(dy), 0, bottom - MIN);
	else bottom = clamp(bottom + units(dy), top + MIN, UNIT);
	return fromUnits(left, top, right - left, bottom - top);
}

/**
 * The area a `videoWidth` x `videoHeight` picture occupies when it is fitted
 * (`object-fit: contain`) into the container, letterboxed or pillarboxed. While
 * the picture's size is unknown (0), the whole container.
 */
export function videoBox(
	containerWidth: number,
	containerHeight: number,
	videoWidth: number,
	videoHeight: number,
): Box {
	if (videoWidth <= 0 || videoHeight <= 0)
		return { x: 0, y: 0, width: containerWidth, height: containerHeight };
	const scale = Math.min(
		containerWidth / videoWidth,
		containerHeight / videoHeight,
	);
	const width = videoWidth * scale;
	const height = videoHeight * scale;
	return {
		x: (containerWidth - width) / 2,
		y: (containerHeight - height) / 2,
		width,
		height,
	};
}

export function sameRect(a: CompositionRect, b: CompositionRect): boolean {
	return (
		a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
	);
}
