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
 * The container is multi-source by construction: `device-stats` keeps five
 * always-present signals under the S1 lock and carries the later collector
 * signals as optional keys, the fan arrives on its own `fan` broadcast, and the
 * model is agnostic to how many broadcasts feed it.
 *
 * DECLARED vs NULL-VALUED. A signal only belongs in the array when the device
 * publishes the interface behind it. "This kernel has no DDR devfreq device" is
 * answered by declaring NO signal; `value: null` is reserved for a signal that
 * exists and had no figure this sample. Collapsing the two would put a label and
 * a waiting-for-data placeholder on screen for hardware that will never answer.
 */
import type { Component, Snippet } from "svelte";

export type DeviceStatTier = "primary" | "secondary";

export type DeviceStatBarTone = "primary" | "warning" | "critical";

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
	 * 0-1. Set ONLY when the signal has a REAL denominator — fan duty, disk-used,
	 * and CPU load against the device's REPORTED core count qualify. SoC
	 * temperature has none, and neither does a load average on a device that did
	 * not report its topology; drawing a bar for either would fabricate a scale
	 * (the same discipline the encoder `percent`-vs-`active` split enforces).
	 */
	fraction?: number;
	/**
	 * Recolours the `fraction` bar for a signal whose magnitude carries a
	 * threshold an operator acts on. Defaults to `primary`, so every existing
	 * tile is unchanged. It is REINFORCEMENT ONLY — a signal using it must also
	 * state its band in words (the `EncoderStatus` colour rule), because a tone
	 * alone is unreadable to a colour-blind or e-ink operator.
	 */
	barTone?: DeviceStatBarTone;
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
	/**
	 * Explanatory `title` on the value — for a figure whose DERIVATION is not
	 * self-evident (the fan's duty cycle, the CPU's share-of-capacity). It may
	 * never carry a STATE: a touchscreen operator cannot hover to read it, so
	 * anything the tile is asserting has to be on screen in words.
	 */
	hint?: string;
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
