/**
 * CPU load as a SHARE OF CAPACITY — the render side of the `device-stats`
 * `cpuLoad1` signal and the `cpu` broadcast's core count.
 *
 * The tile used to print the raw 1-minute load average and nothing else. A load
 * average is a count of runnable tasks, so `1.00` on an 8-core RK3588 is about
 * an eighth of the board — but it reads as saturation to an operator who does
 * not already know the core count, and that ambiguity is what this module
 * removes. Reported live: one software encode pegging a single core showed
 * "CPU Load 1.00" with no reference point anywhere on screen.
 *
 * THE DENOMINATOR IS NEVER ASSUMED. Without a core count there is no honest
 * percentage, so `percent` is `null` and the tile falls back to the raw figure
 * — the same discipline the encoder three-state model enforces for a core that
 * publishes a busy/idle bit rather than a magnitude. Nothing here may substitute
 * a plausible core count.
 *
 * ABOVE 100 % IS REAL AND IS SHOWN. A load average exceeding the core count is
 * genuine oversubscription, so `percent` carries the true figure while
 * `fraction` clamps at 1 — the bar has nowhere further to travel, but the number
 * must not lie about how far past full the board is.
 *
 * THE BAND IS A WORD FIRST. `band` exists so the tile can state "Light" /
 * "Moderate" / "Heavy" in copy; the bar tone that accompanies it is
 * reinforcement, never the signal (the `EncoderStatus` colour rule).
 */

/** Fraction of total capacity at which the load stops reading as comfortable. */
const MODERATE_THRESHOLD = 0.6;

/** Fraction of total capacity at or above which the board is effectively full. */
const HEAVY_THRESHOLD = 0.85;

export type CpuLoadBand = "light" | "moderate" | "heavy";

export interface CpuLoadReading {
	/** The raw 1-minute load average, always preserved as secondary context. */
	load1: number;
	/** Online cores, or `null` when the device could not report a topology. */
	cores: number | null;
	/**
	 * Share of total capacity, rounded to a whole percent. `null` ⇒ no core
	 * count, so no honest percentage exists. May exceed 100 under overload.
	 */
	percent: number | null;
	/** 0-1 bar fill, clamped at full. `null` whenever `percent` is. */
	fraction: number | null;
	/** `null` whenever `percent` is — a band without a denominator is a guess. */
	band: CpuLoadBand | null;
}

function bandFor(ratio: number): CpuLoadBand {
	if (ratio >= HEAVY_THRESHOLD) return "heavy";
	if (ratio >= MODERATE_THRESHOLD) return "moderate";
	return "light";
}

/**
 * `undefined` and `null` are the same answer for both inputs: nothing has been
 * reported. `null` is returned only when the load average itself is missing —
 * that is the tile's "no reading" state, distinct from a load average with no
 * denominator, which still has a real figure to show.
 */
export function deriveCpuLoad(
	load1: number | null | undefined,
	cores: number | null | undefined,
): CpuLoadReading | null {
	if (load1 == null || !Number.isFinite(load1) || load1 < 0) return null;

	const usable =
		cores != null && Number.isFinite(cores) && cores > 0 ? cores : null;
	if (usable === null) {
		return { load1, cores: null, percent: null, fraction: null, band: null };
	}

	const ratio = load1 / usable;
	return {
		load1,
		cores: usable,
		percent: Math.round(ratio * 100),
		fraction: Math.min(1, ratio),
		band: bandFor(ratio),
	};
}
