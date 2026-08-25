/**
 * wifi-adapter-mode-view — the pure derivation behind the three-way mode control.
 *
 * The capability fixtures are the point: a radio whose AP+STA combination is
 * PROVEN offers all three modes, and one whose combination is unproven offers
 * Hybrid disabled WITH a reason. `capability-absent` and `capability-unknown`
 * are asserted as DIFFERENT answers throughout — collapsing them tells an
 * operator their radio cannot do something nobody managed to check.
 */
import type { WifiAdapterModeEntry, WifiInterface } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveWifiAdapterModeView,
	deriveWifiModeConsequence,
	WIFI_ADAPTER_MODES,
	wifiModeErrorKey,
	wifiModeTarget,
} from "./wifi-adapter-mode-view";

function iface(overrides: Partial<WifiInterface> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "MyNet",
		hw: "hw0",
		available: [],
		saved: {},
		...overrides,
	} as WifiInterface;
}

function entry(
	overrides: Partial<WifiAdapterModeEntry> = {},
): WifiAdapterModeEntry {
	return {
		ifname: "wlan0",
		mode: "station",
		options: [
			{ mode: "station", available: true },
			{ mode: "hotspot", available: true },
			{ mode: "hybrid", available: true },
		],
		...overrides,
	};
}

function view(
	input: Partial<Parameters<typeof deriveWifiAdapterModeView>[0]> = {},
) {
	return deriveWifiAdapterModeView({
		device: "wifi0",
		iface: iface(),
		phase: "idle",
		...input,
	});
}

function optionFor(
	v: ReturnType<typeof deriveWifiAdapterModeView>,
	mode: (typeof WIFI_ADAPTER_MODES)[number],
) {
	const found = v.options.find((o) => o.mode === mode);
	if (!found) throw new Error(`no option rendered for ${mode}`);
	return found;
}

describe("the offering is TOTAL and ordered", () => {
	it("always renders all three modes in a fixed order", () => {
		expect(view().options.map((o) => o.mode)).toEqual([
			"station",
			"hotspot",
			"hybrid",
		]);
	});

	it("a mode the device omitted is UNKNOWN, never unavailable-by-omission", () => {
		const v = view({
			entry: entry({ options: [{ mode: "station", available: true }] }),
		});
		expect(optionFor(v, "hybrid").available).toBe(false);
		expect(optionFor(v, "hybrid").reasonKey).toBe(
			"network.wifiMode.reason.capabilityUnknown",
		);
	});

	it("exactly one option is selected, and it is the displayed mode", () => {
		const v = view({ entry: entry({ mode: "hybrid" }) });
		expect(v.options.filter((o) => o.selected).map((o) => o.mode)).toEqual([
			"hybrid",
		]);
		expect(v.displayMode).toBe("hybrid");
	});
});

describe("capability fixtures — staApCombo proven vs unproven", () => {
	it("PROVEN: all three options are enabled and none carries a reason", () => {
		const v = view({ entry: entry() });
		expect(v.options.every((o) => o.available)).toBe(true);
		expect(v.options.every((o) => o.reasonKey === undefined)).toBe(true);
	});

	it("ABSENT: Hybrid is disabled and says the driver cannot do it", () => {
		const v = view({
			entry: entry({
				options: [
					{ mode: "station", available: true },
					{ mode: "hotspot", available: true },
					{
						mode: "hybrid",
						available: false,
						reason: "capability-absent",
					},
				],
			}),
		});
		const hybrid = optionFor(v, "hybrid");
		expect(hybrid.available).toBe(false);
		expect(hybrid.reason).toBe("capability-absent");
		expect(hybrid.reasonKey).toBe("network.wifiMode.reason.capabilityAbsent");
		expect(optionFor(v, "station").available).toBe(true);
		expect(optionFor(v, "hotspot").available).toBe(true);
	});

	it("UNKNOWN: Hybrid is disabled with a DIFFERENT reason than absent", () => {
		const unknown = view({
			entry: entry({
				options: [
					{ mode: "station", available: true },
					{ mode: "hotspot", available: true },
					{
						mode: "hybrid",
						available: false,
						reason: "capability-unknown",
					},
				],
			}),
		});
		const absent = view({
			entry: entry({
				options: [
					{ mode: "station", available: true },
					{ mode: "hotspot", available: true },
					{
						mode: "hybrid",
						available: false,
						reason: "capability-absent",
					},
				],
			}),
		});
		expect(optionFor(unknown, "hybrid").reasonKey).not.toBe(
			optionFor(absent, "hybrid").reasonKey,
		);
	});

	it("UNSUPPORTED: a radio that cannot host an AP loses hotspot AND hybrid", () => {
		const v = view({
			entry: entry({
				options: [
					{ mode: "station", available: true },
					{ mode: "hotspot", available: false, reason: "unsupported" },
					{ mode: "hybrid", available: false, reason: "unsupported" },
				],
			}),
		});
		expect(optionFor(v, "hotspot").reasonKey).toBe(
			"network.wifiMode.reason.unsupported",
		);
		expect(optionFor(v, "hybrid").reasonKey).toBe(
			"network.wifiMode.reason.unsupported",
		);
	});

	it("every unavailable option carries a reason — none is silently withheld", () => {
		for (const reason of [
			"unsupported",
			"capability-absent",
			"capability-unknown",
		] as const) {
			const v = view({
				entry: entry({
					options: [
						{ mode: "station", available: true },
						{ mode: "hotspot", available: true },
						{ mode: "hybrid", available: false, reason },
					],
				}),
			});
			for (const option of v.options) {
				expect(option.available || option.reasonKey !== undefined).toBe(true);
			}
		}
	});
});

describe("the interface fallback — before getAdapterModes answers", () => {
	it("marks itself as NOT device-answered so a surface can tell", () => {
		expect(view().deviceAnswered).toBe(false);
		expect(view({ entry: entry() }).deviceAnswered).toBe(true);
	});

	it("an explicit `false` concurrency flag is a PROVEN negative", () => {
		const v = view({
			iface: iface({
				supports_hotspot: true,
				supports_ap_sta_concurrency: false,
			}),
		});
		expect(optionFor(v, "hybrid").reason).toBe("capability-absent");
	});

	it("an ABSENT concurrency flag is unknown, not a negative", () => {
		const v = view({ iface: iface({ supports_hotspot: true }) });
		expect(optionFor(v, "hybrid").reason).toBe("capability-unknown");
	});

	it("derives hybrid from a live AP on a proven radio (the wire says station)", () => {
		const v = view({
			iface: iface({
				mode: "station",
				supports_hotspot: true,
				supports_ap_sta_concurrency: true,
				hotspot: { name: "AP", password: "pw", available_channels: {} },
			} as Partial<WifiInterface>),
		});
		expect(v.displayMode).toBe("hybrid");
	});

	it("an AP-mode radio reads hotspot", () => {
		const v = view({ iface: iface({ mode: "hotspot" }) });
		expect(v.displayMode).toBe("hotspot");
	});

	it("the device's answer OUTRANKS the interface fallback", () => {
		const v = view({
			iface: iface({ mode: "hotspot" }),
			entry: entry({ mode: "station" }),
		});
		expect(v.displayMode).toBe("station");
	});
});

describe("a pending transition holds the PRIOR mode", () => {
	it("does not flip the control before the device confirms", () => {
		const v = view({
			entry: entry({ mode: "station" }),
			phase: "pending",
			target: "hotspot",
		});
		expect(v.displayMode).toBe("station");
		expect(v.pendingTarget).toBe("hotspot");
		expect(optionFor(v, "hotspot").pending).toBe(true);
		expect(optionFor(v, "station").selected).toBe(true);
	});

	it("holds the persisted preference when the observation already moved", () => {
		// The AP is up but the confirming frame has not landed; falling through to
		// the observation here would flip the control early.
		const v = view({
			entry: entry({ mode: "hotspot", desired: "station" }),
			phase: "pending",
			target: "hotspot",
		});
		expect(v.displayMode).toBe("station");
	});

	it("only the targeted rung shows pending", () => {
		const v = view({ phase: "pending", target: "hybrid" });
		expect(v.options.filter((o) => o.pending).map((o) => o.mode)).toEqual([
			"hybrid",
		]);
	});
});

describe("a terminal failure leaves the PRIOR mode with the reason inline", () => {
	it("keeps the observed mode selected and reports the typed reason", () => {
		const v = view({
			entry: entry({ mode: "station" }),
			phase: "failed",
			target: "hotspot",
			failureReason: "capability-unproven",
		});
		expect(v.displayMode).toBe("station");
		expect(v.pending).toBe(false);
		expect(v.error).toBe("capability-unproven");
		expect(v.errorKey).toBe("network.wifiMode.error.capabilityUnproven");
	});

	it("a TTL timeout is the never-answered sentence, not a refusal", () => {
		const v = view({ phase: "timed_out", target: "hotspot" });
		expect(v.errorKey).toBe("network.wifiMode.error.notConfirmed");
	});

	it("reports NO error while idle or confirmed", () => {
		expect(view({ phase: "idle" }).errorKey).toBeUndefined();
		expect(view({ phase: "confirmed" }).errorKey).toBeUndefined();
	});

	it("maps every wire error token to its own sentence, never a raw token", () => {
		const tokens = [
			"DEVICE_BUSY",
			"no-device",
			"unsupported",
			"capability-unproven",
			"activation-failed",
			"not-confirmed",
			"deactivation-failed",
		] as const;
		const keys = tokens.map((t) => wifiModeErrorKey(t));
		expect(new Set(keys).size).toBe(tokens.length);
		for (const key of keys) {
			expect(key.startsWith("network.wifiMode.error.")).toBe(true);
		}
	});

	it("an unrecognised token degrades to the generic sentence", () => {
		expect(wifiModeErrorKey("something-new")).toBe(
			"network.wifiMode.error.generic",
		);
		expect(wifiModeErrorKey(undefined)).toBe("network.wifiMode.error.generic");
	});
});

describe("a destructive transition is only a LOSS", () => {
	const live = { stationLinkLive: true, hotspotLive: true };

	it("station → hotspot drops the uplink", () => {
		expect(deriveWifiModeConsequence("station", "hotspot", live)).toBe(
			"drops-uplink",
		);
	});

	it("hybrid → hotspot drops the uplink too", () => {
		expect(deriveWifiModeConsequence("hybrid", "hotspot", live)).toBe(
			"drops-uplink",
		);
	});

	it("hotspot → station drops the access point and its clients", () => {
		expect(deriveWifiModeConsequence("hotspot", "station", live)).toBe(
			"drops-hotspot",
		);
	});

	it("station → hybrid is ADDITIVE, so it asks for nothing", () => {
		expect(
			deriveWifiModeConsequence("station", "hybrid", live),
		).toBeUndefined();
	});

	it("hotspot → hybrid restores the station leg without dropping the AP", () => {
		expect(
			deriveWifiModeConsequence("hotspot", "hybrid", live),
		).toBeUndefined();
	});

	it("nothing to lose means nothing to confirm", () => {
		const idle = { stationLinkLive: false, hotspotLive: false };
		for (const from of WIFI_ADAPTER_MODES) {
			for (const to of WIFI_ADAPTER_MODES) {
				expect(deriveWifiModeConsequence(from, to, idle)).toBeUndefined();
			}
		}
	});

	it("selecting the mode already displayed is never destructive", () => {
		for (const mode of WIFI_ADAPTER_MODES) {
			expect(deriveWifiModeConsequence(mode, mode, live)).toBeUndefined();
		}
	});
});

describe("wifiModeTarget narrows the opaque async-op target", () => {
	it("passes a real mode through", () => {
		expect(wifiModeTarget("hybrid")).toBe("hybrid");
	});

	it("treats anything else as no target", () => {
		for (const value of [undefined, null, "", "station2", 7, {}]) {
			expect(wifiModeTarget(value)).toBeUndefined();
		}
	});
});
