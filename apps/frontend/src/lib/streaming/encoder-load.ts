/**
 * Per-core encoder load — the THREE-state model, pure and rune-free.
 *
 * The RK3588 has two independent VEPU580 encoder cores, and **the two kernels
 * CeraLive ships report their load in fundamentally different ways.** Both facts
 * below were verified live on a Rock 5B+, not assumed:
 *
 * | Kernel | Interface | What it reports |
 * |---|---|---|
 * | vendor 6.1 BSP | `/proc/mpp_service/load` (after arming `load_interval`) | a REAL per-core percentage — idle 0.00/0.00, one 1080p30 H.265 session 11.34/0.00, four concurrent sessions 45.53/0.00 |
 * | mainline / edge 7.1 | none — `/proc/mpp_service` does not exist | clock ENABLE STATE only (`clk_enable_count`), a coarse busy/idle bit. Idle 0/0; four concurrent sessions 2/1, i.e. this driver DOES dispatch across both cores |
 *
 * So a core is in one of three states, and **they are not interchangeable**:
 *
 *  1. `percent` — a measured number the device can vouch for.
 *  2. `active`  — busy/idle ONLY. No percentage exists anywhere on this kernel.
 *  3. `unavailable` — neither interface is readable (other hardware, or, today,
 *     no collector wired at all).
 *
 * **State 2 must never be rendered as a percentage.** Drawing `active: true` as
 * "50 %" (or as a half-filled bar) fabricates a denominator the kernel never
 * produced — precisely the class of lie this repo's Live-Data Discipline exists
 * to prevent. There is deliberately NO function in this module that converts an
 * `active` reading to a number, and a unit test pins that absence.
 *
 * Per-CORE, never aggregated: the two cores genuinely differ (vendor kept core 1
 * idle under load in the measurements above; mainline did not), and averaging
 * them would hide the one observation that distinguishes the two drivers.
 *
 * This historical table describes the legacy view. The media island additionally
 * publishes raw block metrics; docs/ENCODER-LOAD.md defines their distinct scale.
 */

import type {
	EncoderLoad,
	EncoderCoreReading as WireCoreReading,
} from "@ceraui/rpc/schemas";

/** Legacy clock fixture ids only; live inventory comes from the wire. */
export const ENCODER_CORE_IDS = ["rkvenc0", "rkvenc1"] as const;
export type EncoderCoreId = (typeof ENCODER_CORE_IDS)[number];

/**
 * Which kernel interface produced a reading. This is provenance, not a label:
 * it is what tells an operator whether the figure beside a core is a measurement
 * or a bit.
 */
export type EncoderLoadSource = NonNullable<EncoderLoad["source"]>;

export type EncoderCoreReading = Readonly<WireCoreReading>;

export type EncoderLoadPrecision = "percent" | "binary" | "none";

type ReadonlyReading<T> = T extends readonly (infer Item)[]
	? readonly ReadonlyReading<Item>[]
	: T extends object
		? { readonly [Key in keyof T]: ReadonlyReading<T[Key]> }
		: T;

export type EncoderLoadReading = ReadonlyReading<EncoderLoad>;

/** The honest floor: nothing is instrumented, so nothing is claimed. */
export const ENCODER_LOAD_UNAVAILABLE: EncoderLoadReading = {
	source: null,
	cores: [],
	updatedAt: null,
	simulated: false,
};

/**
 * Parse a duty-cycle percentage. Anything non-finite or outside `[0, 100]` is
 * refused rather than clamped — an out-of-range figure means the parse was
 * wrong, and a clamped wrong figure still reads as a measurement.
 */
export function parseLoadPercent(raw: unknown): number | null {
	const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
	if (!Number.isFinite(n)) return null;
	if (n < 0 || n > 100) return null;
	return n;
}

/** Build a core reading from a vendor-kernel `mpp_service` percentage. */
export function coreReadingFromPercent(
	core: string,
	raw: unknown,
): EncoderCoreReading {
	const percent = parseLoadPercent(raw);
	return percent === null
		? { core, kind: "unavailable" }
		: { core, kind: "percent", percent };
}

/**
 * Build a core reading from a mainline `clk_enable_count`.
 *
 * A positive count means the core's clock is enabled — the ONLY thing this
 * interface can say. It is NOT a magnitude: the measured `2` and `1` under four
 * concurrent sessions are reference counts, not "twice as busy". Mapping them to
 * a number would be a fabricated scale, so the result is a boolean.
 */
export function coreReadingFromEnableCount(
	core: string,
	raw: unknown,
): EncoderCoreReading {
	const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
	if (!Number.isFinite(n) || n < 0) return { core, kind: "unavailable" };
	return { core, kind: "active", active: n > 0 };
}

/** Is anything at all readable for this device? */
export function isEncoderLoadInstrumented(
	reading: EncoderLoadReading,
): boolean {
	return (
		reading.source !== null &&
		reading.cores.some((core) => core.kind !== "unavailable")
	);
}

/**
 * How precise the reading actually is. Drives which visual vocabulary the panel
 * uses, so an operator can tell a measured number from an on/off bit at a
 * glance without reading a caption.
 */
export function encoderLoadPrecision(
	reading: EncoderLoadReading,
): EncoderLoadPrecision {
	if (reading.cores.some((core) => core.kind === "percent")) return "percent";
	if (reading.cores.some((core) => core.kind === "active")) return "binary";
	return "none";
}

/** Convenience: is any core positively doing work right now? */
export function anyCoreBusy(reading: EncoderLoadReading): boolean {
	return reading.cores.some(
		(core) =>
			(core.kind === "percent" && core.percent > 0) ||
			(core.kind === "active" && core.active),
	);
}

export type EncoderActivity = "encoding" | "idle" | "unreported";

/**
 * The at-a-glance verdict, as a WORD — never a number.
 *
 * A qualitative OR over the cores (`anyCoreBusy`): `percent > 0` and
 * `active === true` are the same CLAIM, and their magnitudes are never
 * compared. The two kinds are incomparable measurements (module header), so
 * averaging or summing them would invent a scale on which they could be added.
 * There is deliberately no variant returning a figure or a fraction, and
 * `encoder-status.test.ts` pins that absence.
 */
export function deriveEncoderActivity(
	reading: EncoderLoadReading,
): EncoderActivity {
	const encoders = reading.blocks?.filter((group) => group.block === "rkvenc");
	if (encoders?.length) {
		const cores = encoders.flatMap((group) => group.cores);
		if (
			cores.some((core) => (core.load ?? 0) > 0 || (core.utilization ?? 0) > 0)
		)
			return "encoding";
		return cores.every((core) => core.load === 0 && core.utilization === 0)
			? "idle"
			: "unreported";
	}
	if (!isEncoderLoadInstrumented(reading)) return "unreported";
	return anyCoreBusy(reading) ? "encoding" : "idle";
}
