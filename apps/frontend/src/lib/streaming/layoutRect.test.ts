import {
	COMPOSITION_LAYOUTS,
	COMPOSITION_RECT_MIN,
	type CompositionRect,
	compositionRectFits,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	clampRect,
	moveRect,
	presetRect,
	resizeRect,
	videoBox,
} from "./layoutRect";

const rect = (x: number, y: number, width: number, height: number) => ({
	x,
	y,
	width,
	height,
});

describe("presetRect", () => {
	it("is the compositor's own arithmetic: half of each axis and a 5% margin", () => {
		expect(presetRect("pip-top-right")).toEqual(rect(0.45, 0.05, 0.5, 0.5));
		expect(presetRect("pip-top-left")).toEqual(rect(0.05, 0.05, 0.5, 0.5));
		expect(presetRect("pip-bottom-right")).toEqual(rect(0.45, 0.45, 0.5, 0.5));
		expect(presetRect("pip-bottom-left")).toEqual(rect(0.05, 0.45, 0.5, 0.5));
		expect(presetRect("pbp-left-right")).toEqual(rect(0.5, 0, 0.5, 1));
		expect(presetRect("pbp-top-bottom")).toEqual(rect(0, 0.5, 1, 0.5));
	});

	it("gives every preset a rectangle the device accepts and the clamp keeps", () => {
		for (const layout of COMPOSITION_LAYOUTS) {
			const placed = presetRect(layout);
			expect(compositionRectFits(placed)).toBe(true);
			expect(clampRect(placed)).toEqual(placed);
		}
	});
});

describe("clampRect", () => {
	const values = [-3, -0.2, 0, 0.01, 0.124, 0.3333, 0.5, 0.875, 0.99, 1, 1.7];

	it("keeps every rectangle inside the frame, each side at least the minimum, and is stable", () => {
		for (const x of values)
			for (const y of values)
				for (const width of values)
					for (const height of values) {
						const clamped = clampRect({ x, y, width, height });
						expect(compositionRectFits(clamped)).toBe(true);
						expect(clamped.width).toBeGreaterThanOrEqual(COMPOSITION_RECT_MIN);
						expect(clamped.height).toBeGreaterThanOrEqual(COMPOSITION_RECT_MIN);
						expect(clampRect(clamped)).toEqual(clamped);
					}
	});

	it("pulls a rectangle that hangs off the frame back inside, keeping its size", () => {
		expect(clampRect(rect(0.9, 0.9, 0.5, 0.5))).toEqual(
			rect(0.5, 0.5, 0.5, 0.5),
		);
		expect(clampRect(rect(-0.2, -0.1, 0.25, 0.25))).toEqual(
			rect(0, 0, 0.25, 0.25),
		);
	});

	it("holds a side below the minimum at the minimum", () => {
		expect(clampRect(rect(0.2, 0.2, 0.01, 0.05))).toEqual(
			rect(0.2, 0.2, COMPOSITION_RECT_MIN, COMPOSITION_RECT_MIN),
		);
	});
});

describe("moveRect", () => {
	it("moves by the given fractions of the frame", () => {
		expect(moveRect(rect(0.45, 0.05, 0.5, 0.5), -0.4, 0.4)).toEqual(
			rect(0.05, 0.45, 0.5, 0.5),
		);
	});

	it("stops at the edge when dragged past it, keeping the size", () => {
		expect(moveRect(rect(0.45, 0.05, 0.5, 0.5), 0.3, -0.3)).toEqual(
			rect(0.5, 0, 0.5, 0.5),
		);
	});
});

describe("resizeRect", () => {
	const start = rect(0.2, 0.2, 0.5, 0.5);

	it("keeps the opposite corner fixed", () => {
		expect(resizeRect(start, "bottom-right", 0.1, 0.05)).toEqual(
			rect(0.2, 0.2, 0.6, 0.55),
		);
		expect(resizeRect(start, "top-left", 0.1, 0.1)).toEqual(
			rect(0.3, 0.3, 0.4, 0.4),
		);
		expect(resizeRect(start, "top-right", 0.1, -0.1)).toEqual(
			rect(0.2, 0.1, 0.6, 0.6),
		);
		expect(resizeRect(start, "bottom-left", -0.1, 0.1)).toEqual(
			rect(0.1, 0.2, 0.6, 0.6),
		);
	});

	it("holds a size below the minimum at the minimum, from either side", () => {
		expect(resizeRect(start, "bottom-right", -0.9, -0.9)).toEqual(
			rect(0.2, 0.2, COMPOSITION_RECT_MIN, COMPOSITION_RECT_MIN),
		);
		expect(resizeRect(start, "top-left", 0.9, 0.9)).toEqual(
			rect(0.575, 0.575, COMPOSITION_RECT_MIN, COMPOSITION_RECT_MIN),
		);
	});

	it("stops at the frame's edge", () => {
		expect(resizeRect(start, "bottom-right", 0.9, 0.9)).toEqual(
			rect(0.2, 0.2, 0.8, 0.8),
		);
		expect(resizeRect(start, "top-left", -0.9, -0.9)).toEqual(
			rect(0, 0, 0.7, 0.7),
		);
	});
});

describe("videoBox", () => {
	it("letterboxes a 16:9 picture in a 4:3 container", () => {
		expect(videoBox(400, 300, 1920, 1080)).toEqual({
			x: 0,
			y: 37.5,
			width: 400,
			height: 225,
		});
	});

	it("pillarboxes a 4:3 picture in a 16:9 container", () => {
		expect(videoBox(1600, 900, 640, 480)).toEqual({
			x: 200,
			y: 0,
			width: 1200,
			height: 900,
		});
	});

	it("uses the whole container while the picture's size is unknown", () => {
		expect(videoBox(640, 360, 0, 0)).toEqual({
			x: 0,
			y: 0,
			width: 640,
			height: 360,
		});
	});
});

describe("a rectangle the device would refuse is never produced", () => {
	it("survives many small steps without drifting past the edge", () => {
		let placed: CompositionRect = rect(0, 0, 0.3333, 0.3333);
		for (let step = 0; step < 200; step += 1) {
			placed = moveRect(placed, 0.01, 0.01);
			placed = resizeRect(placed, "bottom-right", 0.003, 0.007);
			expect(compositionRectFits(placed)).toBe(true);
		}
	});
});
