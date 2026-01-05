/**
 * Safe Svelte Transitions
 *
 * These utilities prevent NaN errors in Svelte transitions when elements
 * have zero dimensions (during rapid mount/unmount cycles).
 */

import { cubicOut } from "svelte/easing";
import type { TransitionConfig } from "svelte/transition";

// ============================================
// Shared Helpers
// ============================================

/** Check if a DOMRect has valid, finite dimensions */
function hasValidDimensions(rect: DOMRect): boolean {
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		isFinite(rect.width) &&
		isFinite(rect.height)
	);
}

/** Get existing CSS transform from an element, or empty string if none */
function getExistingTransform(node: Element): string {
	const style = getComputedStyle(node);
	return style.transform === "none" ? "" : style.transform;
}

/** Create a simple fade transition config (used as fallback when dimensions are invalid) */
function createFadeTransition(
	duration: number,
	easing: (t: number) => number,
	delay = 0,
): TransitionConfig {
	return { duration, delay, easing, css: (t) => `opacity: ${t}` };
}

/** Ensure a number is finite, returning a fallback if not */
function safeNumber(value: number, fallback: number): number {
	return isFinite(value) ? value : fallback;
}

// ============================================
// Transition Parameters Type
// ============================================

export type SafeTransitionParams = {
	start?: number;
	duration?: number;
	delay?: number;
	easing?: (t: number) => number;
};

export type FlyAndScaleParams = {
	y?: number;
	x?: number;
	start?: number;
	duration?: number;
};

// ============================================
// Safe Transitions
// ============================================

/**
 * Safe scale transition that prevents NaN errors when element has zero dimensions.
 * Svelte's built-in scale() calculates Math.sqrt(width * height) which produces NaN
 * when either dimension is 0 (e.g., element not yet rendered or being destroyed).
 */
export function safeScale(
	node: Element,
	params: SafeTransitionParams = {},
): TransitionConfig {
	const { start = 0.95, duration = 150, delay = 0, easing = cubicOut } = params;
	const rect = node.getBoundingClientRect();

	if (!hasValidDimensions(rect)) {
		return createFadeTransition(duration, easing, delay);
	}

	const transform = getExistingTransform(node);
	const safeStart = safeNumber(start, 1);

	return {
		duration,
		delay,
		easing,
		css: (t) => {
			const scale = safeNumber(safeStart + (1 - safeStart) * t, 1);
			return `transform: ${transform} scale(${scale}); opacity: ${t}`;
		},
	};
}

/**
 * Safe crossfade that prevents NaN errors in FLIP animations.
 * Standard crossfade calculates scale ratios between elements which can produce
 * NaN when elements have zero dimensions during mount/unmount.
 */
export function safeCrossfade(options: {
	duration?: number;
	easing?: (t: number) => number;
}): [
	(node: Element, params: { key: string }) => TransitionConfig,
	(node: Element, params: { key: string }) => TransitionConfig,
] {
	const { duration = 200, easing = cubicOut } = options;
	const items = new Map<string, { rect: DOMRect }>();

	function getTransition(
		node: Element,
		params: { key: string },
		isOut: boolean,
	): TransitionConfig {
		const rect = node.getBoundingClientRect();
		const valid = hasValidDimensions(rect);

		if (isOut) {
			if (valid) items.set(params.key, { rect });
			return createFadeTransition(duration / 2, easing);
		}

		const match = items.get(params.key);
		items.delete(params.key);

		if (!match || !valid) {
			return createFadeTransition(duration / 2, easing, duration / 2);
		}

		const dx = safeNumber(match.rect.left - rect.left, 0);
		const dy = safeNumber(match.rect.top - rect.top, 0);

		return {
			duration,
			easing,
			css: (t, u) =>
				`transform: translate(${dx * u}px, ${dy * u}px); opacity: ${t};`,
		};
	}

	return [
		(node, params) => getTransition(node, params, false), // receive/in
		(node, params) => getTransition(node, params, true), // send/out
	];
}

/**
 * Combined fly and scale transition for smooth enter/exit animations.
 * Used primarily by UI components like dropdowns and popovers.
 */
export function flyAndScale(
	node: Element,
	params: FlyAndScaleParams = { y: -8, x: 0, start: 0.95, duration: 150 },
): TransitionConfig {
	const rect = node.getBoundingClientRect();

	// Fallback to fade if dimensions are invalid
	if (!hasValidDimensions(rect)) {
		return createFadeTransition(params.duration ?? 150, cubicOut);
	}

	const transform = getExistingTransform(node);
	const { y = -8, x = 0, start = 0.95, duration = 150 } = params;

	// Linear interpolation helper
	const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

	return {
		duration,
		delay: 0,
		easing: cubicOut,
		css: (t) => {
			const translateY = lerp(y, 0, t);
			const translateX = lerp(x, 0, t);
			const scale = safeNumber(lerp(start, 1, t), 1);

			return `transform: ${transform} translate3d(${translateX}px, ${translateY}px, 0) scale(${scale}); opacity: ${t}`;
		},
	};
}
