/**
 * Dev-only encoder-load fixture — pure, deterministic, and never shipped.
 *
 * Why this lives in the FRONTEND rather than `apps/backend/src/mocks/providers/`
 * ------------------------------------------------------------------------------
 * The backend mock subsystem exists to feed REAL WIRE CONTRACTS: each provider
 * seeds a payload that a genuine broadcast (`sensors`, `device-stats`, `status`,
 * `sources`, …) then carries. There IS now an `encoder-load` broadcast, but its
 * collector is `isRealDevice()`-gated, so on a dev host it publishes NOTHING —
 * and that silence is precisely the seam this fixture fills
 * (`device-health-history.svelte.ts`). Adding a backend provider would mean
 * ungating the collector or minting a second publisher for it: a parallel
 * mocking mechanism racing the real one, for a signal whose absence on a dev
 * host is the honest answer. So the fixture stays beside its consumer, and
 * stays dev-gated.
 *
 * Everything else the panel draws — SoC temperature and the 1-minute load
 * average — comes from the REAL broadcasts, which the backend mock subsystem
 * already feeds in dev. Only this one signal is synthetic, and it says so:
 * `simulated: true` rides every reading and the UI renders that verbatim.
 *
 * The ENCODER shapes are the live Rock 5B+ measurements, not invented behaviour
 * — see `encoder-load.ts` for the measurement table. The DECODER rows are the
 * one exception and say so at their definition: no decode session was ever
 * captured, so those figures are illustrative.
 */

import {
	ENCODER_CORE_IDS,
	ENCODER_LOAD_UNAVAILABLE,
	type EncoderCoreReading,
	type EncoderLoadReading,
} from "./encoder-load";

/**
 * Which kernel reality to simulate.
 *
 * - `vendor`      — `/proc/mpp_service/load` exists ⇒ real per-core percentages.
 * - `mainline`    — only `clk_enable_count` ⇒ busy/idle, no percentage anywhere.
 * - `unavailable` — neither ⇒ the honest not-instrumented state (production).
 */
export const ENCODER_LOAD_MOCK_FLAVORS = [
	"vendor",
	"mainline",
	"unavailable",
] as const;
export type EncoderLoadMockFlavor = (typeof ENCODER_LOAD_MOCK_FLAVORS)[number];

/** Default dev flavour — the kernel the shipped image actually runs. */
export const DEFAULT_ENCODER_LOAD_MOCK_FLAVOR: EncoderLoadMockFlavor = "vendor";

/** `?health-mock=` URL contract, mirroring `?display=`'s parse-or-default rule. */
export const ENCODER_LOAD_MOCK_PARAM = "health-mock";

export function parseEncoderLoadMockFlavor(
	value: string | null | undefined,
): EncoderLoadMockFlavor {
	return (ENCODER_LOAD_MOCK_FLAVORS as readonly string[]).includes(value ?? "")
		? (value as EncoderLoadMockFlavor)
		: DEFAULT_ENCODER_LOAD_MOCK_FLAVOR;
}

/**
 * Idle duty cycle measured on the board: exactly 0.00 % on both cores. Kept as a
 * named constant so the fixture cannot drift into "a small non-zero idle load",
 * which the hardware does not report.
 */
const IDLE_PERCENT = 0;

/** One 1080p30 H.265 session measured 11.34 % on core 0 and 0.00 % on core 1. */
const SESSION_PERCENT_CORE0 = 11.34;

/** The `rkvdecN` ids the vendor parser derives from row position. */
const DECODE_CORE_ID_PREFIX = "rkvdec";

/**
 * The decoder rows, by ROW POSITION — the length is this list's, never the
 * encoder's fixed two-slot one, because a board's decoder count comes from the
 * rows it actually printed.
 *
 * Unlike every encoder figure above, these are NOT board measurements: no
 * decode session was ever captured on the Rock 5B+, and the busy figure is the
 * illustrative row from the vendor parser's own docstring
 * (`apps/backend/src/modules/system/encoder-load.ts`). That is acceptable only
 * because the reading carries `simulated: true` and the UI renders it verbatim —
 * do not promote these numbers into any document as observed behaviour.
 *
 * The `null` slot is deliberate: a figure the parser refuses keeps its row as
 * `unavailable` rather than vanishing, so dev mode exercises the render path
 * that a board would otherwise only reach by printing a malformed row.
 */
const MOCK_DECODE_PERCENTS: readonly (number | null)[] = [23.1, null];

/**
 * Decoder rows for the vendor flavour. Emitted ONLY there: `/proc/mpp_service`
 * is the sole interface that reports decode, so a mainline or unavailable
 * reading omits the key entirely rather than carrying an empty array — an
 * empty array would read as "the decoders were measured at nothing".
 */
function mockDecodeCoresAt(
	t: number,
	streaming: boolean,
): EncoderCoreReading[] {
	return MOCK_DECODE_PERCENTS.map((percent, index) => {
		const core = `${DECODE_CORE_ID_PREFIX}${index}`;
		if (percent === null) return { core, kind: "unavailable" };
		return {
			core,
			kind: "percent",
			percent: streaming ? wobble(percent, t) : IDLE_PERCENT,
		};
	});
}

/**
 * A slow, bounded wobble around the measured figure so the trace is legible in
 * dev without ever leaving the range the board actually produced. Deterministic
 * in `t`, so a test can assert an exact value.
 */
function wobble(base: number, t: number): number {
	const swing = Math.sin(t / 4_000) * 1.6 + Math.sin(t / 1_300) * 0.6;
	return Math.round(Math.max(0, base + swing) * 100) / 100;
}

/**
 * Build a fixture reading. Pure in `(flavor, t, streaming)` — no clock read, no
 * randomness — so both the store and the tests drive the identical function.
 */
export function mockEncoderLoadAt(
	flavor: EncoderLoadMockFlavor,
	t: number,
	streaming: boolean,
): EncoderLoadReading {
	if (flavor === "unavailable") return ENCODER_LOAD_UNAVAILABLE;

	const [core0, core1] = ENCODER_CORE_IDS;

	if (flavor === "vendor") {
		// Vendor 6.1: real percentages, and core 1 stayed idle under load in every
		// measurement taken — reproduced faithfully rather than smoothed into a
		// tidy two-busy-cores story.
		const cores: EncoderCoreReading[] = [
			{
				core: core0,
				kind: "percent",
				percent: streaming ? wobble(SESSION_PERCENT_CORE0, t) : IDLE_PERCENT,
			},
			{ core: core1, kind: "percent", percent: IDLE_PERCENT },
		];
		return {
			source: "mpp-service",
			cores,
			decodeCores: mockDecodeCoresAt(t, streaming),
			updatedAt: t,
			simulated: true,
		};
	}

	// Mainline edge-7.1: clock enable state only. Both cores are dispatched to
	// under load on this driver, which is the observable difference from vendor.
	const cores: EncoderCoreReading[] = [
		{ core: core0, kind: "active", active: streaming },
		{ core: core1, kind: "active", active: streaming },
	];
	return { source: "clk-enable-count", cores, updatedAt: t, simulated: true };
}
