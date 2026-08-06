/**
 * The Device Stats signal model — pure, rune-free, and the reason the section
 * stopped being a list.
 *
 * A flat `Row[]` charged every signal a full row of vertical space and made
 * "add a signal" mean "make the panel taller", which on the 1024x600 kiosk
 * touchscreen is a scroll. The container is now data-driven: a signal declares
 * its TIER and the section decides where it lands, so a new one costs one array
 * entry rather than a redesign.
 *
 * THE TIERING RULE (this, not the current split, is the contract):
 *
 *   primary   — it can change DURING a broadcast and an operator would act on
 *               the change. Rendered as a glance tile.
 *   secondary — a provenance/identity fact that rarely changes, or one whose
 *               richer owner lives elsewhere in the app. Rendered as a row
 *               inside the collapsed details disclosure.
 *
 * The container is multi-source by construction: `device-stats` is frozen at
 * five signals by the S1 lock, so the fan arrives on its own `fan` broadcast and
 * the model is agnostic to how many broadcasts feed it.
 */
import type { Component, Snippet } from "svelte";

export type DeviceStatTier = "primary" | "secondary";

export interface DeviceStatSignal {
	/** Drives `data-testid="device-stat-<key>"` in either tier. */
	key: string;
	icon: Component;
	label: string;
	sub?: string;
	/** `null` ⇒ source unavailable ⇒ render the placeholder, never blank/NaN. */
	value: string | null;
	tier: DeviceStatTier;
	/**
	 * 0-1. Set ONLY when the signal has a REAL denominator — fan duty and
	 * disk-used qualify; SoC temperature and a load average do not, and drawing
	 * a bar for them would fabricate a scale (the same discipline the encoder
	 * `percent`-vs-`active` split enforces).
	 */
	fraction?: number;
	/**
	 * The value is a WORD, not a measurement, so it renders in the UI face rather
	 * than the tabular mono one. "No fan" set in a numeric face reads like a
	 * figure that failed to arrive — which is the opposite of what that state
	 * means: it is a provable statement about the board.
	 */
	prose?: boolean;
	/**
	 * Rendered INSTEAD OF `value`, for a signal whose honest reading is not one
	 * figure. The encoder is the case that forced it: it is two independent cores
	 * whose readings are incomparable, so collapsing them into a string would be
	 * the averaging the whole three-state model forbids.
	 */
	body?: Snippet;
	/** Spans the whole grid row — for a `body` that needs more than a tile. */
	fullWidth?: boolean;
	/** State-specific DOM hooks, e.g. `data-fan-state`. */
	attrs?: Record<string, string>;
}

export interface PartitionedSignals {
	primary: DeviceStatSignal[];
	secondary: DeviceStatSignal[];
}

/** Split by tier, preserving declaration order within each tier. */
export function partitionSignals(
	signals: readonly DeviceStatSignal[],
): PartitionedSignals {
	const primary: DeviceStatSignal[] = [];
	const secondary: DeviceStatSignal[] = [];
	for (const signal of signals) {
		if (signal.tier === "primary") primary.push(signal);
		else secondary.push(signal);
	}
	return { primary, secondary };
}
