import type {
	ConfigMessage,
	Modem,
	ModemList,
	NetifMessage,
	SensorsStatus,
	WifiStatus,
} from "@ceraui/rpc/schemas";
import { describe, expect, it, vi } from "vitest";

// `subscriptions.svelte.ts` declares module-level Svelte runes ($state) which
// would throw under the plain (non-Svelte) vitest environment. Mock it so that
// importing `hud.svelte.ts` never evaluates those runes. The HUD derivation we
// test is pure and does not call these getters.
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getIsStreaming: vi.fn(() => false),
	getConfig: vi.fn(() => undefined),
	getModems: vi.fn(() => undefined),
	getWifi: vi.fn(() => undefined),
	getNetif: vi.fn(() => undefined),
	getSensors: vi.fn(() => undefined),
	getUpdating: vi.fn(() => null),
	getIsConnected: vi.fn(() => false),
	getConnectionState: vi.fn(() => "disconnected"),
}));

import { convertBytesToKbids } from "$lib/helpers/network-speed";
import { modemSignal } from "$lib/helpers/signal";
import type { HudSources, HudTimestamps } from "$lib/types/hud";

import {
	buildLinks,
	deriveHudState,
	isUpdateInProgress,
	MAX_LINKS,
	modemConnectionState,
	parseCurrentAmps,
	parseSensorNumber,
	parseVolts,
	STALE_THRESHOLD_MS,
} from "./hud.svelte";

// ============================================
// Fixtures
// ============================================

const T0 = 1_000_000;

function makeModem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "CarrierA",
		network_type: { supported: ["4g"], active: "4g" },
		status: {
			connection: "connected",
			network_type: "4G",
			signal: 80,
			roaming: false,
			network: "CarrierA",
		},
		...overrides,
	};
}

const wifiFixture: WifiStatus = {
	wlan0: {
		ifname: "wlan0",
		conn: "MyNet",
		hw: "00:11:22",
		available: [
			{ active: true, ssid: "MyNet", signal: 65, security: "WPA2", freq: 5180 },
			{ active: false, ssid: "Other", signal: 40, security: "WPA2", freq: 2412 },
		],
		saved: {},
		supports_hotspot: false,
	},
};

const sensorsFixture: SensorsStatus = {
	"SoC temperature": "43.2°C",
	"SoC current": "1500 mA",
	"SoC voltage": "5.1 V",
};

const configFixture: ConfigMessage = { max_br: 6000 };

// netif keyed by ifname — the join key between links and netif entries.
// Shared fixture stays modem/wifi-only so the derivation count tests are
// unaffected; ethernet-specific cases use netifWithEthFixture below.
const netifFixture: NetifMessage = {
	wwan0: { tp: 128_000, enabled: true, ip: "10.0.0.2" },
	wlan0: { tp: 64_000, enabled: true, ip: "10.0.0.3" },
};

// eth0 (enabled + ip → link), eth1 (no ip → excluded), lo (non-eth → excluded).
const netifWithEthFixture: NetifMessage = {
	...netifFixture,
	eth0: { tp: 256_000, enabled: true, ip: "10.0.0.4" },
	eth1: { tp: 0, enabled: true },
	lo: { tp: 0, enabled: true, ip: "127.0.0.1" },
};

function makeSources(overrides: Partial<HudSources> = {}): HudSources {
	return {
		isStreaming: true,
		isConnected: true,
		connectionState: "connected",
		config: configFixture,
		modems: { modem1: makeModem() } as ModemList,
		wifi: wifiFixture,
		netif: netifFixture,
		sensors: sensorsFixture,
		updating: false,
		...overrides,
	};
}

function makeTimestamps(value: number | null, overrides: Partial<HudTimestamps> = {}): HudTimestamps {
	return {
		streaming: value,
		sensors: value,
		modems: value,
		wifi: value,
		connectionLostAt: null,
		...overrides,
	};
}

// ============================================
// Pure helper tests
// ============================================

describe("parseSensorNumber", () => {
	it("parses unit-suffixed strings", () => {
		expect(parseSensorNumber("43.2°C")).toBe(43.2);
		expect(parseSensorNumber("5.1 V")).toBe(5.1);
	});

	it("passes through finite numbers", () => {
		expect(parseSensorNumber(42)).toBe(42);
	});

	it("returns null for unparseable / nullish input", () => {
		expect(parseSensorNumber("n/a")).toBeNull();
		expect(parseSensorNumber(undefined)).toBeNull();
		expect(parseSensorNumber(null)).toBeNull();
		expect(parseSensorNumber(Number.NaN)).toBeNull();
	});
});

describe("parseCurrentAmps", () => {
	it("converts milliamps to amps", () => {
		expect(parseCurrentAmps("1500 mA")).toBe(1.5);
	});

	it("keeps amps as-is", () => {
		expect(parseCurrentAmps("2.0 A")).toBe(2.0);
	});

	it("returns null on failure", () => {
		expect(parseCurrentAmps(undefined)).toBeNull();
	});
});

describe("parseVolts", () => {
	it("converts millivolts to volts", () => {
		expect(parseVolts("5100 mV")).toBe(5.1);
	});

	it("keeps volts as-is", () => {
		expect(parseVolts("5.1 V")).toBe(5.1);
	});
});

describe("modemSignal", () => {
	it("returns the signal for a normal modem", () => {
		expect(modemSignal(makeModem({ status: { ...makeModem().status!, signal: 73 } }))).toBe(73);
	});

	it("returns null for a no-SIM modem", () => {
		expect(modemSignal(makeModem({ no_sim: true }))).toBeNull();
	});

	it("returns null for a negative/sentinel signal", () => {
		expect(modemSignal(makeModem({ status: { ...makeModem().status!, signal: -1 } }))).toBeNull();
	});

	it("returns null when status is missing", () => {
		expect(modemSignal(makeModem({ status: undefined }))).toBeNull();
	});
});

describe("isUpdateInProgress", () => {
	it("is false for false/null", () => {
		expect(isUpdateInProgress(false)).toBe(false);
		expect(isUpdateInProgress(null)).toBe(false);
		expect(isUpdateInProgress(undefined)).toBe(false);
	});

	it("is true for boolean true", () => {
		expect(isUpdateInProgress(true)).toBe(true);
	});

	it("is true for an in-progress object and false for a finished one", () => {
		expect(
			isUpdateInProgress({ downloading: 1, unpacking: 0, setting_up: 0, total: 5 }),
		).toBe(true);
		expect(
			isUpdateInProgress({ downloading: 5, unpacking: 5, setting_up: 5, total: 5, result: 0 }),
		).toBe(false);
	});
});

// ============================================
// Derivation
// ============================================

describe("deriveHudState — happy path", () => {
	it("populates a complete HudState from valid sources", () => {
		const state = deriveHudState(makeSources(), makeTimestamps(T0), T0);

		expect(state.isStreaming).toBe(true);
		expect(state.bitrateKbps).toBe(6000);
		expect(state.isConnected).toBe(true);
		expect(state.isFullyStale).toBe(false);

		expect(state.temperature).toBe(43.2);
		expect(state.current).toBe(1.5);
		expect(state.voltage).toBe(5.1);

		// 1 wifi + 1 modem = 2 links, none stale.
		expect(state.links).toHaveLength(2);
		expect(state.isStreamingStale).toBe(false);
		expect(state.isSensorsStale).toBe(false);
		expect(state.links.every((l) => !l.isStale)).toBe(true);

		expect(state.lastUpdatedAt.streaming).toBe(T0);
	});
});

describe("deriveHudState — staleness", () => {
	it("flips stale flags once the threshold elapses with no fresh data", () => {
		const now = T0 + STALE_THRESHOLD_MS + 1;
		const state = deriveHudState(makeSources(), makeTimestamps(T0), now);

		expect(state.isStreamingStale).toBe(true);
		expect(state.isBitrateStale).toBe(true);
		expect(state.isSensorsStale).toBe(true);
		expect(state.links.every((l) => l.isStale)).toBe(true);
		// Still connected, so not fully stale.
		expect(state.isFullyStale).toBe(false);
	});

	it("does not mark fresh data stale just under the threshold", () => {
		const now = T0 + STALE_THRESHOLD_MS - 1;
		const state = deriveHudState(makeSources(), makeTimestamps(T0), now);
		expect(state.isStreamingStale).toBe(false);
		expect(state.isSensorsStale).toBe(false);
	});
});

describe("deriveHudState — disconnect", () => {
	it("marks fully stale and preserves last-known values (no nulling)", () => {
		const now = T0 + STALE_THRESHOLD_MS + 1;
		const sources = makeSources({ isConnected: false, connectionState: "disconnected" });
		const timestamps = makeTimestamps(T0, { connectionLostAt: T0 });

		const state = deriveHudState(sources, timestamps, now);

		expect(state.isConnected).toBe(false);
		expect(state.isFullyStale).toBe(true);

		// Last-known values are preserved, not cleared.
		expect(state.temperature).toBe(43.2);
		expect(state.bitrateKbps).toBe(6000);
		expect(state.links).toHaveLength(2);
		expect(state.links.every((l) => l.isStale)).toBe(true);
	});

	it("is not fully stale immediately after the drop (within grace window)", () => {
		const now = T0 + 100;
		const sources = makeSources({ isConnected: false, connectionState: "disconnected" });
		const timestamps = makeTimestamps(T0, { connectionLostAt: T0 });

		const state = deriveHudState(sources, timestamps, now);
		expect(state.isFullyStale).toBe(false);
		// But last-known data is still present.
		expect(state.bitrateKbps).toBe(6000);
	});
});

describe("deriveHudState — reconnect", () => {
	it("clears stale flags once connection is restored and data is fresh", () => {
		const now = T0 + 10_000;
		// Fresh timestamps at `now`, connection back up.
		const state = deriveHudState(
			makeSources(),
			makeTimestamps(now, { connectionLostAt: null }),
			now,
		);

		expect(state.isConnected).toBe(true);
		expect(state.isFullyStale).toBe(false);
		expect(state.isStreamingStale).toBe(false);
		expect(state.isSensorsStale).toBe(false);
		expect(state.links.every((l) => !l.isStale)).toBe(true);
	});
});

describe("deriveHudState — no-SIM / null signal handling", () => {
	it("renders a no-SIM modem with null signal, without crashing", () => {
		const sources = makeSources({
			modems: { modem1: makeModem({ no_sim: true, status: undefined }) } as ModemList,
			wifi: undefined,
		});

		const state = deriveHudState(sources, makeTimestamps(T0), T0);
		expect(state.links).toHaveLength(1);
		const link = state.links[0]!;
		expect(link.type).toBe("modem");
		expect(link.signal).toBeNull();
		expect(link.isConnected).toBe(false);
	});

	it("survives entirely empty sources", () => {
		const empty: HudSources = {
			isStreaming: false,
			isConnected: false,
			connectionState: "connecting",
			config: undefined,
			modems: undefined,
			wifi: undefined,
			netif: undefined,
			sensors: undefined,
			updating: undefined,
		};
		const state = deriveHudState(empty, makeTimestamps(null), T0);
		expect(state.links).toEqual([]);
		expect(state.bitrateKbps).toBeNull();
		expect(state.temperature).toBeNull();
		expect(state.isFullyStale).toBe(false);
	});
});

// ============================================
// Multiple links + index mapping
// ============================================

describe("buildLinks — multiple links & index mapping", () => {
	it("assigns wifi linkIndex 0 then modems 1..n", () => {
		const modems: ModemList = {
			modem1: makeModem({ ifname: "wwan0", name: "CarrierA" }),
			modem2: makeModem({
				ifname: "wwan1",
				name: "CarrierB",
				status: {
					connection: "connected",
					network_type: "5G",
					signal: 55,
					roaming: false,
					network: "CarrierB",
				},
			}),
		};

		const links = buildLinks(modems, wifiFixture, undefined, false, false, false);

		expect(links).toHaveLength(3);
		expect(links[0]).toMatchObject({ type: "wifi", linkIndex: 0, signal: 65 });
		expect(links[1]).toMatchObject({ type: "modem", linkIndex: 1, signal: 80 });
		expect(links[2]).toMatchObject({ type: "modem", linkIndex: 2, signal: 55 });
	});

	it("caps the link list at MAX_LINKS (6)", () => {
		const modems: ModemList = {};
		for (let i = 0; i < 10; i++) {
			modems[`m${i}`] = makeModem({ ifname: `wwan${i}` });
		}
		const links = buildLinks(modems, undefined, undefined, false, false, false);
		expect(links).toHaveLength(6);
		expect(links.map((l) => l.linkIndex)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("propagates staleness flags onto links", () => {
		const links = buildLinks(
			{ modem1: makeModem() } as ModemList,
			wifiFixture,
			undefined,
			true,
			false,
			false,
		);
		const modemLink = links.find((l) => l.type === "modem")!;
		const wifiLink = links.find((l) => l.type === "wifi")!;
		expect(modemLink.isStale).toBe(true);
		expect(wifiLink.isStale).toBe(false);
	});
});

// ============================================
// Ethernet + throughput join + enabled (Task 11)
// ============================================

describe("buildLinks — ethernet links from netif", () => {
	it("emits an ethernet link for an eth interface that is enabled with an IP", () => {
		const links = buildLinks(undefined, undefined, netifWithEthFixture, false, false, false);
		const eth = links.filter((l) => l.type === "ethernet");
		expect(eth).toHaveLength(1);
		expect(eth[0]!.id).toBe("eth0");
		expect(eth[0]!.enabled).toBe(true);
		expect(eth[0]!.isConnected).toBe(true);
	});

	it("excludes eth interfaces without an IP and non-eth entries (lo/wifi/modem)", () => {
		const links = buildLinks(undefined, undefined, netifWithEthFixture, false, false, false);
		const ethIds = links.filter((l) => l.type === "ethernet").map((l) => l.id);
		expect(ethIds).not.toContain("eth1");
		expect(ethIds).not.toContain("lo");
	});

	it("excludes a disabled eth interface even when it has an IP", () => {
		const netif: NetifMessage = {
			eth0: { tp: 10, enabled: false, ip: "10.0.0.4" },
		};
		const links = buildLinks(undefined, undefined, netif, false, false, false);
		expect(links.filter((l) => l.type === "ethernet")).toHaveLength(0);
	});
});

describe("buildLinks — throughput join from netif.tp", () => {
	it("joins throughputKbps via convertBytesToKbids(tp) for modem, wifi, and ethernet", () => {
		const links = buildLinks(
			{ modem1: makeModem({ ifname: "wwan0" }) } as ModemList,
			wifiFixture,
			netifWithEthFixture,
			false,
			false,
			false,
		);
		const wifi = links.find((l) => l.type === "wifi")!;
		const modem = links.find((l) => l.type === "modem")!;
		const eth = links.find((l) => l.type === "ethernet")!;
		expect(wifi.throughputKbps).toBe(convertBytesToKbids(64_000));
		expect(modem.throughputKbps).toBe(convertBytesToKbids(128_000));
		expect(eth.throughputKbps).toBe(convertBytesToKbids(256_000));
	});

	it("defaults throughputKbps to convertBytesToKbids(0) when there is no netif entry", () => {
		const links = buildLinks(
			{ modem1: makeModem({ ifname: "wwan9" }) } as ModemList,
			undefined,
			netifFixture,
			false,
			false,
			false,
		);
		expect(links[0]!.throughputKbps).toBe(convertBytesToKbids(0));
	});
});

describe("buildLinks — enabled propagation from netif", () => {
	it("carries enabled from the matching netif entry", () => {
		const netif: NetifMessage = {
			wwan0: { tp: 0, enabled: false, ip: "10.0.0.2" },
			wlan0: { tp: 0, enabled: true, ip: "10.0.0.3" },
		};
		const links = buildLinks(
			{ modem1: makeModem({ ifname: "wwan0" }) } as ModemList,
			wifiFixture,
			netif,
			false,
			false,
			false,
		);
		expect(links.find((l) => l.type === "modem")!.enabled).toBe(false);
		expect(links.find((l) => l.type === "wifi")!.enabled).toBe(true);
	});

	it("defaults enabled to true when there is no matching netif entry", () => {
		const links = buildLinks(
			{ modem1: makeModem({ ifname: "wwan0" }) } as ModemList,
			undefined,
			undefined,
			false,
			false,
			false,
		);
		expect(links[0]!.enabled).toBe(true);
	});
});

describe("buildLinks — linkIndex stability", () => {
	it("keeps linkIndex stable for remaining links when one link is disabled", () => {
		const modems = {
			modem1: makeModem({ ifname: "wwan0", name: "CarrierA" }),
			modem2: makeModem({ ifname: "wwan1", name: "CarrierB" }),
		} as ModemList;

		const allEnabled: NetifMessage = {
			wlan0: { tp: 0, enabled: true, ip: "10.0.0.3" },
			wwan0: { tp: 0, enabled: true, ip: "10.0.0.4" },
			wwan1: { tp: 0, enabled: true, ip: "10.0.0.5" },
		};
		const withDisabled: NetifMessage = {
			wlan0: { tp: 0, enabled: true, ip: "10.0.0.3" },
			wwan0: { tp: 0, enabled: false, ip: "10.0.0.4" },
			wwan1: { tp: 0, enabled: true, ip: "10.0.0.5" },
		};

		const before = buildLinks(modems, wifiFixture, allEnabled, false, false, false);
		const after = buildLinks(modems, wifiFixture, withDisabled, false, false, false);

		expect(after).toHaveLength(before.length);
		expect(after.map((l) => l.linkIndex)).toEqual(before.map((l) => l.linkIndex));
		expect(after.map((l) => l.id)).toEqual(before.map((l) => l.id));
		const disabled = after.find((l) => l.id === "wwan0")!;
		expect(disabled.enabled).toBe(false);
		expect(disabled.linkIndex).toBe(before.find((l) => l.id === "wwan0")!.linkIndex);
	});
});

// ============================================
// S-cases — signal / connectionState / staleness (Task 20)
//
// These exercise the pure `buildLinks` / `deriveHudState` / `modemConnectionState`
// surface directly (never the reactive runes store). Each block maps to a
// documented S-case: S1 no-SIM, S2 scanning, S5 MAX_LINKS cap, S6 wifi/ethernet
// null-signal-is-valid, plus the per-modem connectionState mapping and the
// deriveHudState staleness / isFullyStale boundary.
// ============================================

describe("S1 — buildLinks includes a no_sim modem with null signal + connectionState 'no_sim'", () => {
	it("emits a modem link for a no-SIM modem (null signal, no_sim state, not connected)", () => {
		const modems: ModemList = {
			modem1: makeModem({
				ifname: "wwan0",
				name: "EmptySlot",
				no_sim: true,
				status: undefined,
			}),
		};

		const links = buildLinks(modems, undefined, undefined, false, false, false);

		expect(links).toHaveLength(1);
		const link = links[0]!;
		expect(link.type).toBe("modem");
		expect(link.id).toBe("wwan0");
		expect(link.signal).toBeNull();
		expect(link.connectionState).toBe("no_sim");
		expect(link.isConnected).toBe(false);
	});

	it("keeps the no_sim modem alongside a healthy modem (no_sim is not filtered out)", () => {
		const modems: ModemList = {
			modem1: makeModem({ ifname: "wwan0", name: "CarrierA" }),
			modem2: makeModem({ ifname: "wwan1", name: "EmptySlot", no_sim: true, status: undefined }),
		};

		const links = buildLinks(modems, undefined, undefined, false, false, false);

		expect(links).toHaveLength(2);
		const noSim = links.find((l) => l.id === "wwan1")!;
		expect(noSim.connectionState).toBe("no_sim");
		expect(noSim.signal).toBeNull();
		const healthy = links.find((l) => l.id === "wwan0")!;
		expect(healthy.connectionState).toBe("connected");
		expect(healthy.signal).toBe(80);
	});

	it("no_sim wins even when a stale status still reports 'connected'", () => {
		const modem = makeModem({
			no_sim: true,
			status: { connection: "connected", network_type: "4G", signal: 90, roaming: false },
		});
		expect(modemConnectionState(modem)).toBe("no_sim");
		expect(modemSignal(modem)).toBeNull();
	});
});

describe("S2 — buildLinks marks a scanning modem with connectionState 'scanning'", () => {
	it("maps status.connection 'scanning' to connectionState 'scanning' (not connected)", () => {
		const modems: ModemList = {
			modem1: makeModem({
				ifname: "wwan0",
				name: "Searching",
				status: {
					connection: "scanning",
					network_type: "4G",
					signal: 0,
					roaming: false,
				},
			}),
		};

		const links = buildLinks(modems, undefined, undefined, false, false, false);

		expect(links).toHaveLength(1);
		const link = links[0]!;
		expect(link.connectionState).toBe("scanning");
		expect(link.isConnected).toBe(false);
	});
});

describe("S5 — buildLinks caps the returned links at MAX_LINKS", () => {
	it("returns exactly MAX_LINKS links when given more modems than the cap", () => {
		const modems: ModemList = {};
		for (let i = 0; i < MAX_LINKS + 4; i++) {
			modems[`m${i}`] = makeModem({ ifname: `wwan${i}`, name: `Carrier${i}` });
		}

		const links = buildLinks(modems, undefined, undefined, false, false, false);

		expect(links).toHaveLength(MAX_LINKS);
		expect(links.map((l) => l.linkIndex)).toEqual(
			Array.from({ length: MAX_LINKS }, (_, i) => i),
		);
	});

	it("respects the cap across a wifi + modem mix (wifi first, then modems up to the cap)", () => {
		const modems: ModemList = {};
		for (let i = 0; i < MAX_LINKS + 2; i++) {
			modems[`m${i}`] = makeModem({ ifname: `wwan${i}`, name: `Carrier${i}` });
		}

		const links = buildLinks(modems, wifiFixture, undefined, false, false, false);

		expect(links).toHaveLength(MAX_LINKS);
		// WiFi takes index 0; the remaining slots are modems.
		expect(links[0]!.type).toBe("wifi");
		expect(links.filter((l) => l.type === "modem")).toHaveLength(MAX_LINKS - 1);
	});
});

describe("S6 — wifi/ethernet null signal is valid, not an error", () => {
	it("includes a wifi link with signal null when no network is active (disconnected)", () => {
		const wifi: WifiStatus = {
			wlan0: {
				ifname: "wlan0",
				conn: "",
				hw: "00:11:22",
				available: [{ active: false, ssid: "Other", signal: 40, security: "WPA2", freq: 2412 }],
				saved: {},
				supports_hotspot: false,
			},
		};

		const links = buildLinks(undefined, wifi, undefined, false, false, false);

		expect(links).toHaveLength(1);
		const link = links[0]!;
		expect(link.type).toBe("wifi");
		expect(link.signal).toBeNull();
		expect(link.isConnected).toBe(false);
		expect(link.connectionState).toBe("disconnected");
		// Generic fallback label when no active SSID.
		expect(link.label).toBe("WiFi");
	});

	it("includes an active wifi link with signal null when the reading is non-finite (no crash)", () => {
		const wifi: WifiStatus = {
			wlan0: {
				ifname: "wlan0",
				conn: "MyNet",
				hw: "00:11:22",
				available: [
					// Active network with a sentinel/non-finite signal — must coerce to null, stay connected.
					{ active: true, ssid: "MyNet", signal: Number.NaN, security: "WPA2", freq: 5180 },
				],
				saved: {},
				supports_hotspot: false,
			},
		};

		const links = buildLinks(undefined, wifi, undefined, false, false, false);

		expect(links).toHaveLength(1);
		const link = links[0]!;
		expect(link.signal).toBeNull();
		expect(link.isConnected).toBe(true);
		expect(link.connectionState).toBe("connected");
	});

	it("includes an ethernet link with signal null (ethernet never reports a signal)", () => {
		const netif: NetifMessage = {
			eth0: { tp: 256_000, enabled: true, ip: "10.0.0.4" },
		};

		const links = buildLinks(undefined, undefined, netif, false, false, false);

		expect(links).toHaveLength(1);
		const link = links[0]!;
		expect(link.type).toBe("ethernet");
		expect(link.signal).toBeNull();
		expect(link.isConnected).toBe(true);
		expect(link.connectionState).toBe("connected");
	});
});

describe("connectionState — per-modem backend mapping", () => {
	function stateFor(connection: string): string {
		const modem = makeModem({
			status: {
				connection: connection as never,
				network_type: "4G",
				signal: 70,
				roaming: false,
			},
		});
		return modemConnectionState(modem);
	}

	it("maps 'connected' to 'connected'", () => {
		expect(stateFor("connected")).toBe("connected");
	});

	it("maps 'scanning' to 'scanning'", () => {
		expect(stateFor("scanning")).toBe("scanning");
	});

	it("collapses 'failed' to 'disconnected'", () => {
		expect(stateFor("failed")).toBe("disconnected");
	});

	it("collapses 'registered' to 'disconnected'", () => {
		expect(stateFor("registered")).toBe("disconnected");
	});

	it("collapses 'connecting' to 'disconnected'", () => {
		expect(stateFor("connecting")).toBe("disconnected");
	});

	it("collapses a missing status to 'disconnected'", () => {
		expect(modemConnectionState(makeModem({ status: undefined }))).toBe("disconnected");
	});

	it("populates connectionState onto each modem link via buildLinks", () => {
		const modems: ModemList = {
			connected: makeModem({ ifname: "wwan0" }),
			scanning: makeModem({
				ifname: "wwan1",
				status: { connection: "scanning", network_type: "4G", signal: 0, roaming: false },
			}),
			failed: makeModem({
				ifname: "wwan2",
				status: { connection: "failed", network_type: "4G", signal: 0, roaming: false },
			}),
			registered: makeModem({
				ifname: "wwan3",
				status: { connection: "registered", network_type: "4G", signal: 30, roaming: false },
			}),
			noSim: makeModem({ ifname: "wwan4", no_sim: true, status: undefined }),
		};

		const links = buildLinks(modems, undefined, undefined, false, false, false);
		const byId = (id: string) => links.find((l) => l.id === id)!;

		expect(byId("wwan0").connectionState).toBe("connected");
		expect(byId("wwan1").connectionState).toBe("scanning");
		expect(byId("wwan2").connectionState).toBe("disconnected");
		expect(byId("wwan3").connectionState).toBe("disconnected");
		expect(byId("wwan4").connectionState).toBe("no_sim");
	});
});

describe("deriveHudState — isFullyStale staleness boundary", () => {
	it("is fully stale once the connection has been down longer than STALE_THRESHOLD_MS", () => {
		const now = T0 + STALE_THRESHOLD_MS + 1;
		const sources = makeSources({ isConnected: false, connectionState: "disconnected" });
		const timestamps = makeTimestamps(T0, { connectionLostAt: T0 });

		const state = deriveHudState(sources, timestamps, now);

		expect(state.isFullyStale).toBe(true);
		// Fully-stale forces every link stale even when its own source timestamp is fresh.
		const fresh = deriveHudState(
			sources,
			makeTimestamps(now, { connectionLostAt: T0 }),
			now,
		);
		expect(fresh.links.every((l) => l.isStale)).toBe(true);
	});

	it("is exactly at the threshold (>=) — boundary is inclusive", () => {
		const now = T0 + STALE_THRESHOLD_MS;
		const sources = makeSources({ isConnected: false, connectionState: "disconnected" });
		const timestamps = makeTimestamps(T0, { connectionLostAt: T0 });

		const state = deriveHudState(sources, timestamps, now);
		expect(state.isFullyStale).toBe(true);
	});

	it("is NOT fully stale one ms before the threshold (grace window)", () => {
		const now = T0 + STALE_THRESHOLD_MS - 1;
		const sources = makeSources({ isConnected: false, connectionState: "disconnected" });
		const timestamps = makeTimestamps(T0, { connectionLostAt: T0 });

		const state = deriveHudState(sources, timestamps, now);
		expect(state.isFullyStale).toBe(false);
	});

	it("is never fully stale while still connected, regardless of age", () => {
		const now = T0 + STALE_THRESHOLD_MS * 100;
		const state = deriveHudState(makeSources(), makeTimestamps(T0, { connectionLostAt: null }), now);
		expect(state.isConnected).toBe(true);
		expect(state.isFullyStale).toBe(false);
	});
});

describe("modemSignal — frontend defense against string wire values", () => {
	it("coerces a numeric string signal to a number (backend may emit '53')", () => {
		const modem = makeModem({
			status: { connection: "connected", network_type: "4G", signal: "53" as never, roaming: false },
		});
		expect(modemSignal(modem)).toBe(53);
	});

	it("returns null for a non-numeric string signal (graceful, no NaN leak)", () => {
		const modem = makeModem({
			status: { connection: "connected", network_type: "4G", signal: "n/a" as never, roaming: false },
		});
		expect(modemSignal(modem)).toBeNull();
	});
});
