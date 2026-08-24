/**
 * THE PER-ADAPTER MODE IS EXPLICIT, PERSISTED, AND MAPS ONTO THE EXISTING MODEL.
 *
 * Before this, "does this radio keep its station leg while hosting an AP" was
 * decided implicitly by a capability read: any adapter that PROVED an AP+STA
 * combination got a concurrent hotspot, and an operator who wanted an exclusive
 * access point on a capable radio had no way to ask for one. Capability answers
 * whether a radio CAN; only the operator can answer whether it SHOULD.
 *
 * The suite drives the pure rules AND the wiring, because the two halves fail
 * differently: a capability gate can be right while the transition ignores it,
 * and a transition can be right while nothing persists what it did.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import type { WifiAdapterMode } from "@ceraui/rpc/schemas";

import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	getWifiState,
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import {
	buildWifiAdapterModeStatus,
	getPersistedWifiAdapterMode,
	observedWifiAdapterMode,
	persistWifiAdapterMode,
	WIFI_ADAPTER_MODES,
	wifiAdapterModeOptions,
} from "../modules/wifi/wifi-adapter-mode.ts";
import type { AdapterModeOutcome } from "../modules/wifi/wifi-adapter-mode-outcome.ts";
import {
	type AdapterModeTransitionDeps,
	reconcileWifiAdapterModes,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { startHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import type { HotspotOutcomePublisher } from "../modules/wifi/wifi-hotspot-outcome.ts";
import type {
	HotspotActivationDeps,
	WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";

const MAC = "dc:a6:32:aa:bb:c0";
const SECOND_MAC = "dc:a6:32:aa:bb:c1";

function makeIface(
	over: {
		id?: number;
		ifname?: string;
		conn?: string | null;
		hotspotConn?: string;
		concurrentActive?: boolean;
		supportsApStaConcurrency?: boolean;
		withoutHotspot?: boolean;
	} = {},
): WifiInterface {
	const base = {
		id: over.id ?? 0,
		ifname: over.ifname ?? "wlan0",
		conn: over.conn ?? null,
		hw: "Realtek RTL8852BE",
		available: new Map(),
		saved: {},
		savedAll: {},
	};
	if (over.withoutHotspot) return base as WifiInterface;

	const iface: WifiInterfaceWithHotspot = {
		...base,
		...(over.supportsApStaConcurrency
			? { supportsApStaConcurrency: true }
			: {}),
		hotspot: {
			...(over.hotspotConn ? { conn: over.hotspotConn } : {}),
			availableChannels: ["auto"],
			warnings: {},
		},
	};
	if (over.concurrentActive && over.hotspotConn) {
		iface.concurrentHotspot = {
			ifname: `clap-${iface.ifname}`,
			activeConn: over.hotspotConn,
		};
	}
	return iface;
}

const combo = (supported: boolean | undefined) =>
	supported === undefined
		? () => undefined
		: () => ({ staApCombo: { supported } });

interface Recorder {
	readonly calls: string[];
	readonly frames: Array<{
		device: number | string;
		outcome: AdapterModeOutcome;
	}>;
	readonly hotspotFrames: Array<Parameters<HotspotOutcomePublisher>>;
}

function makeDeps(
	interfaces: Record<string, WifiInterface>,
	over: Partial<AdapterModeTransitionDeps> = {},
): { deps: AdapterModeTransitionDeps; recorder: Recorder } {
	const recorder: Recorder = { calls: [], frames: [], hotspotFrames: [] };
	const deps: AdapterModeTransitionDeps = {
		resolveInterfaces: () => interfaces,
		readCapabilities: combo(true),
		isAdapterBusy: async () => false,
		startHotspot: async (device, publish) => {
			recorder.calls.push(`start:${device}`);
			publish("start", device, { success: true });
			return { success: true };
		},
		stopHotspot: async (device, publish) => {
			recorder.calls.push(`stop:${device}`);
			publish("stop", device, { success: true });
			return { success: true };
		},
		publishOutcome: (device, outcome) => {
			recorder.frames.push({ device, outcome });
		},
		publishHotspotOutcome: (...args) => {
			recorder.hotspotFrames.push(args);
		},
		persistMode: persistWifiAdapterMode,
		restoreMode: (macAddress, previous) => {
			const config = getConfig();
			const next = { ...(config.wifi_modes ?? {}) };
			if (previous === undefined) delete next[macAddress];
			else next[macAddress] = previous;
			config.wifi_modes = next;
		},
		readPersistedMode: getPersistedWifiAdapterMode,
		...over,
	};
	return { deps, recorder };
}

const terminalFrames = (recorder: Recorder) =>
	recorder.frames.filter((frame) => !("pending" in frame.outcome));

let previousConfigFile = "";

beforeEach(() => {
	previousConfigFile = getConfigFilePath();
	setConfigFilePath(
		`${process.env.TMPDIR ?? "/tmp"}/ceraui-wifi-mode-${process.pid}.json`,
	);
	getConfig().wifi_modes = undefined;
	setWifiState({});
	onWifiChange(() => {});
});

afterEach(() => {
	getConfig().wifi_modes = undefined;
	setConfigFilePath(previousConfigFile);
});

afterAll(async () => {
	await Bun.file(
		`${process.env.TMPDIR ?? "/tmp"}/ceraui-wifi-mode-${process.pid}.json`,
	)
		.delete()
		.catch(() => {});
});

describe("the offered set is capability-gated and never hides a mode", () => {
	test("hybrid is offered only when the AP+STA combination is PROVEN", () => {
		const options = wifiAdapterModeOptions({
			supportsHotspot: true,
			staApComboSupported: true,
		});
		expect(options.find((o) => o.mode === "hybrid")).toEqual({
			mode: "hybrid",
			available: true,
		});
	});

	test("a wiphy that answered and forbids the pair is `capability-absent`", () => {
		const options = wifiAdapterModeOptions({
			supportsHotspot: true,
			staApComboSupported: false,
		});
		expect(options.find((o) => o.mode === "hybrid")).toEqual({
			mode: "hybrid",
			available: false,
			reason: "capability-absent",
		});
	});

	test("an unproven capability is `capability-unknown`, NOT absent", () => {
		const options = wifiAdapterModeOptions({
			supportsHotspot: true,
			staApComboSupported: undefined,
		});
		const hybrid = options.find((o) => o.mode === "hybrid");
		expect(hybrid?.available).toBe(false);
		// Absence of evidence is not evidence of absence: telling an operator the
		// radio CANNOT do it is a different claim from never having asked.
		expect(hybrid?.reason).toBe("capability-unknown");
	});

	test("a radio that cannot host an AP at all refuses both AP modes", () => {
		const options = wifiAdapterModeOptions({
			supportsHotspot: false,
			staApComboSupported: true,
		});
		expect(options).toEqual([
			{ mode: "station", available: true },
			{ mode: "hotspot", available: false, reason: "unsupported" },
			{ mode: "hybrid", available: false, reason: "unsupported" },
		]);
	});

	test("the offered set is TOTAL — every mode, always, with an explicit flag", () => {
		for (const supportsHotspot of [true, false]) {
			for (const staApComboSupported of [true, false, undefined]) {
				const options = wifiAdapterModeOptions({
					supportsHotspot,
					staApComboSupported,
				});
				expect(options.map((o) => o.mode)).toEqual([...WIFI_ADAPTER_MODES]);
				for (const option of options) {
					expect(typeof option.available).toBe("boolean");
					expect(option.available).toBe(option.reason === undefined);
				}
			}
		}
	});
});

describe("the operator mode maps onto the EXISTING wire model", () => {
	test("a concurrent AP is `hybrid` here and still `station` on the wire", () => {
		const iface = makeIface({
			conn: "station-uuid",
			hotspotConn: "hotspot-uuid",
			concurrentActive: true,
			supportsApStaConcurrency: true,
		});
		setWifiState({ [MAC]: { ...iface, mode: "station" } });

		expect(observedWifiAdapterMode(iface)).toBe("hybrid");
		// The pinned assertion the three-way selector must never disturb.
		expect(getWifiState()[MAC]?.mode).toBe("station");
	});

	test("an exclusive AP is `hotspot`, and a plain station is `station`", () => {
		const hotspot = makeIface({
			conn: "hotspot-uuid",
			hotspotConn: "hotspot-uuid",
		});
		expect(observedWifiAdapterMode(hotspot)).toBe("hotspot");
		expect(observedWifiAdapterMode(makeIface())).toBe("station");
	});

	test("the status projection carries observed, desired and the offered set", () => {
		persistWifiAdapterMode(MAC, "hybrid");
		const status = buildWifiAdapterModeStatus(
			{ [MAC]: makeIface({ supportsApStaConcurrency: true }) },
			combo(true),
		);
		expect(status["0"]?.mode).toBe("station");
		expect(status["0"]?.desired).toBe("hybrid");
		expect(status["0"]?.options).toHaveLength(3);
	});

	test("an adapter with no stated preference reports none", () => {
		const status = buildWifiAdapterModeStatus(
			{ [MAC]: makeIface() },
			combo(true),
		);
		expect(status["0"]?.desired).toBeUndefined();
	});
});

describe("the six transitions", () => {
	const cases: Array<{
		from: WifiAdapterMode;
		to: WifiAdapterMode;
		iface: () => WifiInterface;
		expected: string[];
	}> = [
		{
			from: "station",
			to: "hotspot",
			iface: () => makeIface(),
			expected: ["start:0"],
		},
		{
			from: "station",
			to: "hybrid",
			iface: () => makeIface({ supportsApStaConcurrency: true }),
			expected: ["start:0"],
		},
		{
			from: "hotspot",
			to: "station",
			iface: () =>
				makeIface({ conn: "hotspot-uuid", hotspotConn: "hotspot-uuid" }),
			expected: ["stop:0"],
		},
		{
			from: "hybrid",
			to: "station",
			iface: () =>
				makeIface({
					conn: "station-uuid",
					hotspotConn: "hotspot-uuid",
					concurrentActive: true,
					supportsApStaConcurrency: true,
				}),
			expected: ["stop:0"],
		},
		{
			from: "hotspot",
			to: "hybrid",
			iface: () =>
				makeIface({
					conn: "hotspot-uuid",
					hotspotConn: "hotspot-uuid",
					supportsApStaConcurrency: true,
				}),
			expected: ["stop:0", "start:0"],
		},
		{
			from: "hybrid",
			to: "hotspot",
			iface: () =>
				makeIface({
					conn: "station-uuid",
					hotspotConn: "hotspot-uuid",
					concurrentActive: true,
					supportsApStaConcurrency: true,
				}),
			expected: ["stop:0", "start:0"],
		},
	];

	for (const testCase of cases) {
		test(`${testCase.from} -> ${testCase.to} runs the right profile operations and settles`, async () => {
			const iface = testCase.iface();
			expect(observedWifiAdapterMode(iface)).toBe(testCase.from);

			const { deps, recorder } = makeDeps({ [MAC]: iface });
			const result = await setWifiAdapterMode(0, testCase.to, deps);

			expect(result.success).toBe(true);
			expect(recorder.calls).toEqual(testCase.expected);
			expect(getPersistedWifiAdapterMode(MAC)).toBe(testCase.to);

			// Exactly one pending frame, then exactly one terminal frame naming the
			// mode that was reached.
			expect(
				recorder.frames.filter((f) => "pending" in f.outcome),
			).toHaveLength(1);
			const terminal = terminalFrames(recorder);
			expect(terminal).toHaveLength(1);
			expect(terminal[0]?.outcome).toEqual({
				success: true,
				mode: testCase.to,
			});
			// The hotspot's own frames are still published by the branch that always
			// published them — the mode terminal is added beside them, never instead.
			expect(recorder.hotspotFrames.length).toBeGreaterThan(0);
		});
	}

	test("asking for the mode the radio is already in settles without touching it", async () => {
		const iface = makeIface();
		const { deps, recorder } = makeDeps({ [MAC]: iface });

		const result = await setWifiAdapterMode(0, "station", deps);

		expect(result).toEqual({ success: true, applied: "station" });
		expect(recorder.calls).toEqual([]);
		// Nothing was dispatched, so no confirmation will ever settle and this
		// branch owes the terminal frame itself.
		expect(terminalFrames(recorder)).toHaveLength(1);
		expect(getPersistedWifiAdapterMode(MAC)).toBe("station");
	});

	test("a busy adapter is refused without persisting or dispatching", async () => {
		const { deps, recorder } = makeDeps(
			{ [MAC]: makeIface() },
			{ isAdapterBusy: async () => true },
		);

		const result = await setWifiAdapterMode(0, "hotspot", deps);

		expect(result).toEqual({ success: false, error: "DEVICE_BUSY" });
		expect(recorder.calls).toEqual([]);
		expect(getPersistedWifiAdapterMode(MAC)).toBeUndefined();
		expect(terminalFrames(recorder)[0]?.outcome).toEqual({
			success: false,
			error: "DEVICE_BUSY",
		});
	});

	test("an unknown device is refused with a terminal frame", async () => {
		const { deps, recorder } = makeDeps({ [MAC]: makeIface() });
		const result = await setWifiAdapterMode(9, "hotspot", deps);
		expect(result).toEqual({ success: false, error: "no-device" });
		expect(terminalFrames(recorder)).toHaveLength(1);
	});
});

describe("hybrid is refused when the capability is not proven", () => {
	for (const [label, supported] of [
		["unknown", undefined],
		["absent", false],
	] as const) {
		test(`a ${label} AP+STA combination refuses hybrid, and says so`, async () => {
			const { deps, recorder } = makeDeps(
				{ [MAC]: makeIface({ supportsApStaConcurrency: true }) },
				{ readCapabilities: combo(supported) },
			);

			const result = await setWifiAdapterMode(0, "hybrid", deps);

			expect(result).toEqual({ success: false, error: "capability-unproven" });
			expect(recorder.calls).toEqual([]);
			expect(getPersistedWifiAdapterMode(MAC)).toBeUndefined();
			expect(terminalFrames(recorder)[0]?.outcome).toEqual({
				success: false,
				error: "capability-unproven",
			});
		});
	}

	test("a radio that cannot host an AP refuses `hotspot` as unsupported", async () => {
		const { deps } = makeDeps({ [MAC]: makeIface({ withoutHotspot: true }) });
		expect(await setWifiAdapterMode(0, "hotspot", deps)).toEqual({
			success: false,
			error: "unsupported",
		});
	});
});

describe("a failed transition rolls the persisted mode back", () => {
	test("an NM activation refusal restores the previous preference", async () => {
		persistWifiAdapterMode(MAC, "station");
		const { deps, recorder } = makeDeps(
			{ [MAC]: makeIface({ supportsApStaConcurrency: true }) },
			{
				startHotspot: async (device, publish) => {
					publish("start", device, {
						success: false,
						error: "activation-failed",
					});
					return { success: false, error: "activation-failed" };
				},
			},
		);

		const result = await setWifiAdapterMode(0, "hybrid", deps);

		expect(result).toEqual({ success: false, error: "activation-failed" });
		expect(getPersistedWifiAdapterMode(MAC)).toBe("station");
		expect(terminalFrames(recorder)[0]?.outcome).toEqual({
			success: false,
			error: "activation-failed",
		});
	});

	test("an adapter that had NO preference does not acquire one from a failure", async () => {
		const { deps } = makeDeps(
			{ [MAC]: makeIface() },
			{
				startHotspot: async () => ({
					success: false,
					error: "activation-failed",
				}),
			},
		);

		await setWifiAdapterMode(0, "hotspot", deps);

		expect(getPersistedWifiAdapterMode(MAC)).toBeUndefined();
	});

	test("a teardown that fails aborts the switch and restores the preference", async () => {
		persistWifiAdapterMode(MAC, "hotspot");
		const { deps, recorder } = makeDeps(
			{
				[MAC]: makeIface({
					conn: "hotspot-uuid",
					hotspotConn: "hotspot-uuid",
					supportsApStaConcurrency: true,
				}),
			},
			{
				stopHotspot: async () => ({
					success: false,
					error: "deactivation-failed",
				}),
			},
		);

		const result = await setWifiAdapterMode(0, "hybrid", deps);

		expect(result).toEqual({ success: false, error: "deactivation-failed" });
		expect(recorder.calls).toEqual([]);
		expect(getPersistedWifiAdapterMode(MAC)).toBe("hotspot");
		expect(terminalFrames(recorder)[0]?.outcome).toEqual({
			success: false,
			error: "deactivation-failed",
		});
	});

	test("a `not-confirmed` outcome KEEPS the preference so the next boot retries", async () => {
		const { deps, recorder } = makeDeps(
			{ [MAC]: makeIface({ supportsApStaConcurrency: true }) },
			{
				startHotspot: async (device, publish) => {
					// NetworkManager ACCEPTED and simply never reported the AP up, so
					// the radio may still reach the mode — discarding the operator's
					// stated intent here would also stop the next boot retrying it.
					publish("start", device, { success: false, error: "not-confirmed" });
					return { success: true };
				},
			},
		);

		const result = await setWifiAdapterMode(0, "hybrid", deps);

		expect(result).toEqual({
			success: true,
			accepted: true,
			applied: "hybrid",
		});
		expect(getPersistedWifiAdapterMode(MAC)).toBe("hybrid");
		expect(terminalFrames(recorder)[0]?.outcome).toEqual({
			success: false,
			error: "not-confirmed",
		});
	});
});

describe("boot reconciliation is idempotent and fail-soft", () => {
	const noSleep = async () => {};

	test("an adapter already in its stated mode is not touched", async () => {
		persistWifiAdapterMode(MAC, "station");
		const { deps, recorder } = makeDeps({ [MAC]: makeIface() });

		await reconcileWifiAdapterModes(
			deps,
			() => ({ [MAC]: "station" }),
			noSleep,
		);
		await reconcileWifiAdapterModes(
			deps,
			() => ({ [MAC]: "station" }),
			noSleep,
		);

		expect(recorder.calls).toEqual([]);
		expect(recorder.frames).toEqual([]);
	});

	test("a stated mode the radio is not in is re-applied, once per run", async () => {
		persistWifiAdapterMode(MAC, "hybrid");
		const iface = makeIface({ supportsApStaConcurrency: true });
		const { deps, recorder } = makeDeps({ [MAC]: iface });

		await reconcileWifiAdapterModes(deps, () => ({ [MAC]: "hybrid" }), noSleep);

		expect(recorder.calls).toEqual(["start:0"]);
		expect(getPersistedWifiAdapterMode(MAC)).toBe("hybrid");
	});

	test("no stated preference reconciles nothing at all", async () => {
		const { deps, recorder } = makeDeps({ [MAC]: makeIface() });
		await reconcileWifiAdapterModes(deps, () => ({}), noSleep);
		expect(recorder.calls).toEqual([]);
	});

	test("an absent adapter is skipped and its preference SURVIVES", async () => {
		persistWifiAdapterMode(SECOND_MAC, "hotspot");
		const { deps, recorder } = makeDeps({ [MAC]: makeIface() });

		await reconcileWifiAdapterModes(
			deps,
			() => ({ [SECOND_MAC]: "hotspot" }),
			noSleep,
		);

		expect(recorder.calls).toEqual([]);
		expect(getPersistedWifiAdapterMode(SECOND_MAC)).toBe("hotspot");
	});

	test("a target that is not currently offered is left alone, never cleared", async () => {
		persistWifiAdapterMode(MAC, "hybrid");
		const { deps, recorder } = makeDeps(
			{ [MAC]: makeIface({ supportsApStaConcurrency: true }) },
			{ readCapabilities: combo(undefined) },
		);

		await reconcileWifiAdapterModes(deps, () => ({ [MAC]: "hybrid" }), noSleep);

		expect(recorder.calls).toEqual([]);
		// A capability read that has not landed must not be read as a refusal that
		// discards the operator's choice.
		expect(getPersistedWifiAdapterMode(MAC)).toBe("hybrid");
	});

	test("a throwing transition never rejects, and never fails boot", async () => {
		persistWifiAdapterMode(MAC, "hotspot");
		const { deps } = makeDeps(
			{ [MAC]: makeIface() },
			{
				startHotspot: async () => {
					throw new Error("nmcli exploded");
				},
			},
		);

		await expect(
			reconcileWifiAdapterModes(deps, () => ({ [MAC]: "hotspot" }), noSleep),
		).resolves.toBeUndefined();
		expect(getPersistedWifiAdapterMode(MAC)).toBe("hotspot");
	});

	test("a throwing preference read never rejects either", async () => {
		const { deps } = makeDeps({ [MAC]: makeIface() });
		await expect(
			reconcileWifiAdapterModes(
				deps,
				() => {
					throw new Error("unreadable config");
				},
				noSleep,
			),
		).resolves.toBeUndefined();
	});
});

describe("exclusive vs concurrent is the OPERATOR's choice, not the radio's", () => {
	function activationDeps(
		over: Partial<HotspotActivationDeps>,
	): HotspotActivationDeps {
		return {
			nmConnect: async () => true,
			nmConnSetFields: async () => true,
			nmHotspot: async () => "hotspot-uuid",
			wifiUpdateSavedConns: async () => {},
			broadcastState: () => {},
			setDupIpSuppression: () => {},
			credentials: { get: () => undefined, remember: () => {} },
			findHotspotConn: async () => undefined,
			pruneHotspotConns: async () => {},
			...over,
		};
	}

	test("`hotspot` takes the EXCLUSIVE path on a concurrency-capable radio", async () => {
		const iface = makeIface({
			conn: "station-uuid",
			supportsApStaConcurrency: true,
		}) as WifiInterfaceWithHotspot;
		const hotspotDevices: string[] = [];
		const dupCalls: Array<[string, boolean]> = [];
		let ensured = 0;

		const deps = activationDeps({
			preferConcurrentAp: () => false,
			ensureConcurrentInterface: async () => {
				ensured++;
				return { ifname: "clap-wlan0", created: true };
			},
			nmHotspot: async (device) => {
				hotspotDevices.push(device);
				return "hotspot-uuid";
			},
			setDupIpSuppression: (ifname, value) => dupCalls.push([ifname, value]),
		});

		expect(await startHotspotForInterface(MAC, iface, deps)).toEqual({
			success: true,
		});
		expect(ensured).toBe(0);
		// The AP is hosted on the PHYSICAL interface, and the parent therefore
		// takes the dup-IP suppression an exclusive switch has always taken.
		expect(hotspotDevices).toEqual(["wlan0"]);
		expect(dupCalls).toEqual([["wlan0", true]]);
		expect(iface.concurrentHotspot).toBeUndefined();
	});

	test("`hybrid` takes the CONCURRENT path on the same radio", async () => {
		const iface = makeIface({
			conn: "station-uuid",
			supportsApStaConcurrency: true,
		}) as WifiInterfaceWithHotspot;
		const hotspotDevices: string[] = [];

		const deps = activationDeps({
			preferConcurrentAp: () => true,
			ensureConcurrentInterface: async () => ({
				ifname: "clap-wlan0",
				created: true,
			}),
			nmHotspot: async (device) => {
				hotspotDevices.push(device);
				return "hotspot-uuid";
			},
		});

		expect(await startHotspotForInterface(SECOND_MAC, iface, deps)).toEqual({
			success: true,
		});
		expect(hotspotDevices).toEqual(["clap-wlan0"]);
		expect(iface.concurrentHotspot?.ifname).toBe("clap-wlan0");
	});

	test("an adapter with NO stated preference keeps the pre-selector behaviour", async () => {
		const iface = makeIface({
			conn: "station-uuid",
			supportsApStaConcurrency: true,
		}) as WifiInterfaceWithHotspot;
		const hotspotDevices: string[] = [];

		// No `preferConcurrentAp` dep at all: the `?? true` default is what keeps a
		// capable radio concurrent exactly as it was before the mode existed.
		const deps = activationDeps({
			ensureConcurrentInterface: async () => ({
				ifname: "clap-wlan0",
				created: true,
			}),
			nmHotspot: async (device) => {
				hotspotDevices.push(device);
				return "hotspot-uuid";
			},
		});

		await startHotspotForInterface("dc:a6:32:aa:bb:c2", iface, deps);

		expect(hotspotDevices).toEqual(["clap-wlan0"]);
	});
});
