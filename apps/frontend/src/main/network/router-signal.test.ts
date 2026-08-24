/**
 * The pure half of todo 21: reading todo 20's normalized router-dongle signal.
 *
 * FIXTURE PROVENANCE, stated because todo 20's evidence insists on it. All three
 * HiLink/ZTE bench units are SIM-LESS, so NO capture exists in which one of
 * these dongles reported a populated radio metric — every captured `<rsrp>` is
 * an empty element and ZTE's `signalbar` is `""`. The blank-and-SIM-less cases
 * below ARE the bench truth and are asserted as such; the populated ones are
 * SHAPE-DERIVED (field names, nesting and per-dialect support come from the
 * captured envelopes, only the numbers are supplied) and are never presented as
 * readings taken from hardware.
 */
import type {
	Modem,
	RouterSignal,
	RouterSignalMetric,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import type { RouterSignalUnknownReason } from "./router-signal";
import {
	dominantUnknownReason,
	resolveRouterSignalReadout,
	resolveSignalInstrument,
	routerSignalMetricRows,
	routerSignalReasonKey,
	routerSignalStateKey,
	tierFromBars,
	tierFromDbm,
} from "./router-signal";

const known = (value: number): RouterSignalMetric => ({
	state: "known",
	value,
});
const unknown = (
	reason: Extract<RouterSignalMetric, { state: "unknown" }>["reason"],
): RouterSignalMetric => ({ state: "unknown", reason });

const UNSUPPORTED = unknown("unsupported");
const NOT_REPORTED = unknown("not-reported");

/** HiLink: bars + scale + rssi/rsrp/rsrq/sinr. It publishes NO `snr` key. */
function hilink(over: Partial<RouterSignal> = {}): RouterSignal {
	return {
		provenance: "hilink-admin-api",
		freshness: "live",
		bars: known(4),
		max_bars: known(5),
		dbm: known(-71),
		rsrp: known(-95),
		rsrq: known(-11),
		snr: UNSUPPORTED,
		sinr: known(9),
		...over,
	};
}

/** ZTE: `signalbar` on a fixed 5-scale + `lte_snr`. It publishes NO `sinr`. */
function zte(over: Partial<RouterSignal> = {}): RouterSignal {
	return {
		provenance: "zte-goform",
		freshness: "live",
		bars: known(3),
		max_bars: known(5),
		dbm: known(-79),
		rsrp: known(-98),
		rsrq: known(-12),
		snr: known(7),
		sinr: UNSUPPORTED,
		...over,
	};
}

/** UFI: `himiapi` publishes ONE scalar and no bar scale whatsoever. */
function ufi(over: Partial<RouterSignal> = {}): RouterSignal {
	return {
		provenance: "ufi-himiapi",
		freshness: "live",
		bars: UNSUPPORTED,
		max_bars: UNSUPPORTED,
		dbm: known(-96),
		rsrp: UNSUPPORTED,
		rsrq: UNSUPPORTED,
		snr: UNSUPPORTED,
		sinr: UNSUPPORTED,
		...over,
	};
}

function allUnknown(
	base: RouterSignal,
	reason: Extract<RouterSignalMetric, { state: "unknown" }>["reason"],
): RouterSignal {
	const next = { ...base, freshness: "unknown" as const };
	for (const id of [
		"bars",
		"max_bars",
		"dbm",
		"rsrp",
		"rsrq",
		"snr",
		"sinr",
	] as const) {
		if (base[id].state === "unknown" && base[id].reason === "unsupported")
			continue;
		next[id] = unknown(reason);
	}
	return next;
}

function dongle(
	signal: RouterSignal | undefined,
	over: Partial<Modem> = {},
): Modem {
	return {
		ifname: "enx0c5b8f279a64",
		name: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			...(signal !== undefined ? { signal } : {}),
		},
		...over,
	} as Modem;
}

describe("tier derivation — only from a quantity the device published", () => {
	it("reads a bar count as a RATIO of the device's own scale", () => {
		expect(tierFromBars(5, 5)).toBe("high");
		expect(tierFromBars(4, 5)).toBe("high");
		expect(tierFromBars(3, 5)).toBe("medium");
		expect(tierFromBars(2, 5)).toBe("medium");
		expect(tierFromBars(1, 5)).toBe("low");
	});

	it("does not treat 3-of-4 and 3-of-5 as the same reading", () => {
		expect(tierFromBars(3, 4)).toBe("high");
		expect(tierFromBars(3, 5)).toBe("medium");
	});

	it("resolves a device-stated ZERO to `none` — the only route to 'No signal'", () => {
		expect(tierFromBars(0, 5)).toBe("none");
	});

	it("refuses a bar count with no usable scale rather than inventing one", () => {
		expect(tierFromBars(3, 0)).toBeUndefined();
		expect(tierFromBars(3, Number.NaN)).toBeUndefined();
		expect(tierFromBars(-1, 5)).toBeUndefined();
	});

	it("never resolves a published dBm figure to `none`", () => {
		expect(tierFromDbm(-60)).toBe("high");
		expect(tierFromDbm(-80)).toBe("medium");
		expect(tierFromDbm(-96)).toBe("low");
		// A measurement was still taken, however weak — "no signal" is a claim only
		// a stated zero-bar count can make.
		expect(tierFromDbm(-125)).toBe("low");
		expect(tierFromDbm(Number.NaN)).toBeUndefined();
	});
});

describe("the row readout — one per dialect, plus every degraded case", () => {
	it("prefers the device's own bar scale when it stated both halves", () => {
		const readout = resolveRouterSignalReadout(dongle(hilink()));
		expect(readout).toEqual({
			kind: "reading",
			provenance: "hilink-admin-api",
			freshness: "live",
			tier: "high",
			basis: "bars",
		});
	});

	it("falls through to dBm for a dialect that publishes no bar scale (UFI)", () => {
		const readout = resolveRouterSignalReadout(dongle(ufi()));
		expect(readout).toEqual({
			kind: "reading",
			provenance: "ufi-himiapi",
			freshness: "live",
			tier: "low",
			basis: "dbm",
		});
	});

	it("carries the ZTE provenance verbatim — the two dongles are not interchangeable", () => {
		expect(resolveRouterSignalReadout(dongle(zte()))?.provenance).toBe(
			"zte-goform",
		);
	});

	it("reports NOTHING — not a zero-bar reading — when the device stated an empty slot", () => {
		// The real bench HiLink: `SimStatus 255`, `SignalIcon 0`, `maxsignal 5`,
		// every element of `/api/device/signal` present and EMPTY. `NoSimBadge`
		// owns the empty slot, so silence is the right answer here — and the
		// second assertion is the one that matters: `0 / 5` must never become a
		// `none` tier.
		const benchTruth = hilink({
			bars: known(0),
			max_bars: known(5),
			dbm: NOT_REPORTED,
			rsrp: NOT_REPORTED,
			rsrq: NOT_REPORTED,
			sinr: NOT_REPORTED,
		});
		const simless = dongle(benchTruth, {
			router_admin: {
				admin_url: "http://192.168.8.1",
				reachable: true,
				sim: "absent",
				signal: benchTruth,
			},
		} as Partial<Modem>);

		expect(resolveRouterSignalReadout(simless)).toBeUndefined();
		expect(resolveSignalInstrument(simless)).toEqual({ kind: "none" });

		// Non-vacuity: the SAME payload with a card in the slot DOES resolve, so
		// the silence above is the slot's doing and not a broken fixture.
		expect(resolveRouterSignalReadout(dongle(benchTruth))).toMatchObject({
			kind: "reading",
			tier: "none",
		});
	});

	it.each([
		["unreachable", "unreachable"],
		["auth-expired", "auth-expired"],
		["malformed", "malformed"],
		["not-reported", "not-reported"],
	] as const)(
		"reports %s as itself, with no tier at all",
		(...args: [RouterSignalUnknownReason, RouterSignalUnknownReason]) => {
			const [reason] = args;
			const readout = resolveRouterSignalReadout(
				dongle(allUnknown(hilink(), reason)),
			);
			expect(readout).toEqual({
				kind: "unknown",
				provenance: "hilink-admin-api",
				freshness: "unknown",
				reason,
			});
		},
	);

	it("reports the WIDEST failure when metrics disagree", () => {
		const mixed = hilink({
			bars: unknown("not-reported"),
			max_bars: unknown("not-reported"),
			dbm: unknown("malformed"),
			rsrp: unknown("auth-expired"),
			rsrq: unknown("unreachable"),
			sinr: unknown("not-reported"),
		});
		expect(dominantUnknownReason(mixed)).toBe("unreachable");
	});

	it("reads the real blank-`signalbar` ZTE capture as not-reported, never as zero", () => {
		const blank = zte({
			bars: NOT_REPORTED,
			max_bars: NOT_REPORTED,
			dbm: NOT_REPORTED,
			rsrp: NOT_REPORTED,
			rsrq: NOT_REPORTED,
			snr: NOT_REPORTED,
		});
		const readout = resolveRouterSignalReadout(dongle(blank));
		expect(readout).toMatchObject({ kind: "unknown", reason: "not-reported" });
		expect(routerSignalStateKey(readout as NonNullable<typeof readout>)).toBe(
			"network.routerCellular.signal.reason.notReported",
		);
	});

	it("keeps a carried-over reading, and keeps it labelled as the past tense it is", () => {
		const readout = resolveRouterSignalReadout(
			dongle(hilink({ freshness: "stale" })),
		);
		expect(readout).toMatchObject({
			kind: "reading",
			freshness: "stale",
			tier: "high",
		});
	});

	it("renders NOTHING for a backend that publishes no normalized model", () => {
		expect(resolveRouterSignalReadout(dongle(undefined))).toBeUndefined();
	});

	it("renders NOTHING for a row that is not a router dongle at all", () => {
		expect(
			resolveRouterSignalReadout({
				ifname: "wwan0",
				network_type: { supported: [], active: null },
				status: { connection: "connected", signal: 81 },
			} as unknown as Modem),
		).toBeUndefined();
	});
});

describe("ONE row draws ONE instrument, and one rule decides which", () => {
	const mmRadio = {
		ifname: "wwan0",
		network_type: { supported: [], active: null },
		status: { connection: "connected", signal: 81 },
	} as unknown as Modem;

	it("prefers the device stack's own radio whenever it published one", () => {
		expect(resolveSignalInstrument(mmRadio)).toEqual({
			kind: "device-stack",
			tier: "high",
		});
	});

	it("falls through to the admin API only when the stack reported nothing", () => {
		const instrument = resolveSignalInstrument(dongle(hilink()));
		expect(instrument.kind).toBe("device-admin");
		expect(instrument).toMatchObject({
			readout: { provenance: "hilink-admin-api", tier: "high" },
		});
	});

	it("still answers ONE instrument for a row that somehow published both", () => {
		// Impossible by construction on the wire — an MM row carries no
		// `router_admin` and a router row no `status` — which is exactly why the
		// precedence must live in one place rather than be restated per surface.
		const both = {
			...dongle(hilink()),
			status: { connection: "connected", signal: 81 },
		} as Modem;
		expect(resolveSignalInstrument(both)).toEqual({
			kind: "device-stack",
			tier: "high",
		});
	});

	it("answers `none` when neither instrument reported anything renderable", () => {
		expect(resolveSignalInstrument(dongle(undefined))).toEqual({
			kind: "none",
		});
	});
});

describe("the detail strip — an unsupported metric is ABSENT, never a dash", () => {
	function ids(signal: RouterSignal): string[] {
		return routerSignalMetricRows(signal).map((row) => row.id);
	}

	it("omits `snr` for HiLink — that API has no such key", () => {
		expect(ids(hilink())).toEqual(["bars", "dbm", "rsrp", "rsrq", "sinr"]);
	});

	it("omits `sinr` for ZTE — it publishes `lte_snr` instead", () => {
		expect(ids(zte())).toEqual(["bars", "dbm", "rsrp", "rsrq", "snr"]);
	});

	it("leaves UFI with the one scalar it actually has", () => {
		expect(ids(ufi())).toEqual(["dbm"]);
	});

	it("keeps an unsupported metric out even when the whole read failed", () => {
		expect(ids(allUnknown(ufi(), "unreachable"))).toEqual(["dbm"]);
	});

	it("carries each metric's OWN unit — power is dBm, the ratios are dB", () => {
		const rows = routerSignalMetricRows(hilink());
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get("dbm")).toMatchObject({ state: "known", value: "-71 dBm" });
		expect(byId.get("rsrp")).toMatchObject({
			state: "known",
			value: "-95 dBm",
		});
		expect(byId.get("rsrq")).toMatchObject({ state: "known", value: "-11 dB" });
		expect(byId.get("sinr")).toMatchObject({ state: "known", value: "9 dB" });
	});

	it("prints a bar count only alongside the scale that explains it", () => {
		expect(routerSignalMetricRows(zte())[0]).toMatchObject({
			id: "bars",
			state: "known",
			value: "3 / 5",
		});
		const scaleless = routerSignalMetricRows(
			zte({ max_bars: NOT_REPORTED }),
		)[0];
		expect(scaleless).toMatchObject({ id: "bars", state: "unknown" });
	});

	it("reports a degraded metric by NAME rather than dropping it", () => {
		const rows = routerSignalMetricRows(allUnknown(hilink(), "auth-expired"));
		expect(rows).toHaveLength(5);
		for (const row of rows) {
			expect(row.state).toBe("unknown");
			expect(row).toMatchObject({
				reasonKey: "network.routerCellular.signal.reason.authExpired",
			});
		}
	});

	it("never lets an unknown metric carry a value", () => {
		for (const reason of [
			"unreachable",
			"auth-expired",
			"malformed",
			"not-reported",
		] as const) {
			for (const row of routerSignalMetricRows(allUnknown(zte(), reason))) {
				expect(row.state).toBe("unknown");
				expect("value" in row).toBe(false);
			}
		}
	});
});

describe("every reason resolves to keyed copy, never to a raw token", () => {
	it.each([
		["unsupported", "network.routerCellular.signal.reason.unsupported"],
		["not-reported", "network.routerCellular.signal.reason.notReported"],
		["malformed", "network.routerCellular.signal.reason.malformed"],
		["auth-expired", "network.routerCellular.signal.reason.authExpired"],
		["unreachable", "network.routerCellular.signal.reason.unreachable"],
	] as const)("%s", (reason, key) => {
		expect(routerSignalReasonKey(reason)).toBe(key);
	});

	it("gives a reading the SAME four tier words the MM radio glyph already uses", () => {
		expect(
			routerSignalStateKey({
				kind: "reading",
				provenance: "zte-goform",
				freshness: "live",
				tier: "medium",
				basis: "bars",
			}),
		).toBe("network.cellular.signal.medium");
	});
});
