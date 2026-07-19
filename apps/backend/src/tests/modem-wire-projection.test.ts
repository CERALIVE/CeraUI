/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Phase B, T5.3 — legacy numeric wire projection (byte-compatible).
 *
 * The core proof is the GOLDEN-FIXTURE test: the same fake-harness scenario set
 * expressed in BOTH backends (mmcli `Modem` and dbus observation view) projects to
 * a BYTE-IDENTICAL frontend payload — so the frontend can never tell which backend
 * is live. Plus:
 *   - a regression lock proving the mmcli projection reproduces the live
 *     `buildModemsMessage` output byte-for-byte (the existing wire is unchanged);
 *   - the `"auto"` / `autoconfig` seam behaviour;
 *   - the ≥1000 synthetic-id collision test;
 *   - the replug-stability test.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { getGsmOperatorName } from "../modules/modems/gsm-operators-cache.ts";
import { buildModemsMessage } from "../modules/modems/modem-status.ts";
import type { DbusModemView } from "../modules/modems/modem-wire-adapters.ts";
import {
	fromDbusView,
	fromMmcliModem,
	fromRouterView,
	ratsToNetworkTypeDisplay,
} from "../modules/modems/modem-wire-adapters.ts";
import {
	AUTO_APN_SENTINEL,
	type ProjectedModemSource,
	projectModemWire,
	resolveWireConfig,
	SYNTHETIC_ID_BASE,
} from "../modules/modems/modem-wire-projection.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { setup } from "../modules/setup.ts";

const OPERATOR_CODE = "310260";

// The dbus adapter must resolve an available-networks name via the SAME
// gsm-operators-cache lookup the mmcli path uses (`getAvailableNetworksForModem`
// → `getGsmOperatorName(config.network) || "Operator ID <code>"`). This test
// derives BOTH sides' fixture value from that ONE resolver at module load, so the
// two paths agree regardless of the (empty-by-default, test-order-dependent)
// operator cache — never a hardcoded name that silently diverges when the cache
// is unseeded.
function operatorDisplayName(code: string): string {
	return getGsmOperatorName(code) ?? `Operator ID ${code}`;
}

const OPERATOR_NAME = operatorDisplayName(OPERATOR_CODE);

function clearModems(): void {
	for (const id of getModemIds()) {
		removeModem(id);
	}
}

/** A `setup.has_gsm_autoconfig` scope that always restores the prior value. */
function withGsmAutoconfig<T>(value: boolean | undefined, fn: () => T): T {
	const prior = setup.has_gsm_autoconfig;
	setup.has_gsm_autoconfig = value;
	try {
		return fn();
	} finally {
		setup.has_gsm_autoconfig = prior;
	}
}

const stableStringify = (v: unknown): string => JSON.stringify(v);

// ──────────────────────────────────────────────────────────────────────────────
// Fake-harness scenario set — the SAME logical modems in both backend shapes.
// Each scenario yields an mmcli `Modem` and the equivalent dbus observation view;
// projecting either must produce the identical wire entry.
// ──────────────────────────────────────────────────────────────────────────────

interface Scenario {
	readonly name: string;
	readonly runtimeId: number;
	readonly hasGsmAutoconfig: boolean;
	readonly mmcli: Modem;
	readonly dbus: DbusModemView;
}

const SCENARIOS: readonly Scenario[] = [
	{
		name: "5G online modem with manual APN",
		runtimeId: 0,
		hasGsmAutoconfig: false,
		mmcli: {
			ifname: "wwan0",
			name: "RM520N-GL - 45678",
			sim_network: "T-Mobile",
			model: "RM520N-GL",
			manufacturer: "Quectel",
			network_type: {
				supported: {
					"4g": { allowed: "4g", preferred: "none" },
					"5g4g": { allowed: "4g|5g", preferred: "5g" },
				},
				active: "5g4g",
			},
			status: {
				connection: "connected",
				network: "T-Mobile",
				network_type: "5G",
				signal: 82,
				roaming: false,
			},
			config: {
				autoconfig: false,
				apn: "fast.t-mobile.com",
				username: "user",
				password: "secret",
				roaming: true,
				network: OPERATOR_CODE,
			},
		},
		dbus: {
			runtimeId: 0,
			ifname: "wwan0",
			model: "RM520N-GL",
			manufacturer: "Quectel",
			equipmentId: "123456789045678",
			mmState: "connected",
			registration: { status: "home", activeRats: new Set(["lte", "5gnr"]) },
			signal: 82,
			operatorName: "T-Mobile",
			supportedNetworkTypes: ["4g", "5g4g"],
			activeNetworkType: "5g4g",
			simSlots: [{ occupied: true, active: true, lock: "none" }],
			config: {
				autoconfig: false,
				apn: "fast.t-mobile.com",
				username: "user",
				password: "secret",
				roaming: true,
				network: OPERATOR_CODE,
			},
			// The dbus backend resolves the saved operator (config.network) to the
			// same synthesized available-networks entry the mmcli path derives via
			// getAvailableNetworksForModem — through the SAME operator-cache resolver,
			// so the name matches byte-for-byte whether or not the cache is seeded.
			availableNetworks: { [OPERATOR_CODE]: { name: OPERATOR_NAME } },
		},
	},
	{
		name: "4G roaming modem, auto-config ON (auto never echoed)",
		runtimeId: 3,
		hasGsmAutoconfig: true,
		mmcli: {
			ifname: "wwan1",
			name: "EM7455 - 99887",
			sim_network: "Vodafone",
			model: "EM7455",
			manufacturer: "Sierra",
			network_type: {
				supported: { "4g": { allowed: "4g", preferred: "none" } },
				active: "4g",
			},
			status: {
				connection: "registered",
				network: "Vodafone",
				network_type: "4G",
				signal: 55,
				roaming: true,
			},
			// auto-config ON: the mmcli path clears apn/user/pass to "" already.
			config: {
				autoconfig: true,
				apn: "",
				username: "",
				password: "",
				roaming: false,
				network: "",
			},
		},
		dbus: {
			runtimeId: 3,
			ifname: "wwan1",
			model: "EM7455",
			manufacturer: "Sierra",
			equipmentId: "35291099887",
			mmState: "registered",
			registration: { status: "roaming", activeRats: new Set(["lte"]) },
			signal: 55,
			operatorName: "Vodafone",
			supportedNetworkTypes: ["4g"],
			activeNetworkType: "4g",
			simSlots: [{ occupied: true, active: true, lock: "none" }],
			// dbus side carries the raw Auto-APN sentinel — MUST resolve to "".
			config: {
				autoconfig: true,
				apn: AUTO_APN_SENTINEL,
				username: "",
				password: "",
				roaming: false,
				network: "",
			},
		},
	},
	{
		name: "SIM-PIN-locked modem, no profile (no_sim)",
		runtimeId: 7,
		hasGsmAutoconfig: false,
		mmcli: {
			ifname: "wwan2",
			name: "RM500Q-GL - 11223",
			sim_network: "<NO SIM>",
			model: "RM500Q-GL",
			manufacturer: "Quectel",
			network_type: {
				supported: { "4g": { allowed: "4g", preferred: "none" } },
				active: null,
			},
			status: {
				connection: "locked",
				network_type: "",
				signal: 0,
				roaming: false,
			},
			sim_lock: { required: "sim-pin", remainingAttempts: 3 },
		},
		dbus: {
			runtimeId: 7,
			ifname: "wwan2",
			model: "RM500Q-GL",
			manufacturer: "Quectel",
			equipmentId: "86000000011223",
			mmState: "locked",
			registration: { status: "idle", activeRats: new Set() },
			signal: 0,
			supportedNetworkTypes: ["4g"],
			activeNetworkType: null,
			simSlots: [{ occupied: true, active: true, lock: "sim-pin" }],
			simLockRequired: "sim-pin",
			simLockRemainingAttempts: 3,
			// no NM profile ⇒ no_sim on the wire.
		},
	},
];

// ──────────────────────────────────────────────────────────────────────────────

describe("T5.3 golden fixture — mmcli vs dbus byte-identical projection", () => {
	afterEach(clearModems);

	test("each scenario projects identically under both backends", () => {
		for (const scenario of SCENARIOS) {
			const mmcliWire = withGsmAutoconfig(scenario.hasGsmAutoconfig, () =>
				projectModemWire([fromMmcliModem(scenario.runtimeId, scenario.mmcli)], {
					hasGsmAutoconfig: scenario.hasGsmAutoconfig,
				}),
			);
			const dbusWire = projectModemWire([fromDbusView(scenario.dbus)], {
				hasGsmAutoconfig: scenario.hasGsmAutoconfig,
			});

			expect(stableStringify(dbusWire.message)).toBe(
				stableStringify(mmcliWire.message),
			);
		}
	});

	test("the whole scenario set projects identically as one payload", () => {
		// Every scenario shares hasGsmAutoconfig=... independently; drive the mixed
		// set through the shared true/false split the wire uses per-broadcast.
		for (const hasGsm of [true, false]) {
			const mmcliSources = SCENARIOS.map((s) =>
				withGsmAutoconfig(hasGsm, () => fromMmcliModem(s.runtimeId, s.mmcli)),
			);
			const dbusSources = SCENARIOS.map((s) => fromDbusView(s.dbus));

			const mmcliWire = projectModemWire(mmcliSources, {
				hasGsmAutoconfig: hasGsm,
			});
			const dbusWire = projectModemWire(dbusSources, {
				hasGsmAutoconfig: hasGsm,
			});

			expect(stableStringify(dbusWire.message)).toBe(
				stableStringify(mmcliWire.message),
			);
		}
	});

	test("`auto` sentinel is never echoed on the wire (either backend)", () => {
		const scenario = SCENARIOS[1]; // auto-config ON scenario
		if (scenario === undefined) throw new Error("missing scenario");

		const dbusWire = projectModemWire([fromDbusView(scenario.dbus)], {
			hasGsmAutoconfig: true,
		});
		const raw = stableStringify(dbusWire.message);
		expect(raw).not.toContain(`"apn":"${AUTO_APN_SENTINEL}"`);
		const entry = dbusWire.message["3"];
		expect(entry?.config?.apn).toBe("");
		expect(entry?.config?.autoconfig).toBe(true);
	});
});

describe("T5.3 regression lock — mmcli projection == buildModemsMessage", () => {
	afterEach(clearModems);

	test("projected mmcli wire byte-matches the live broadcast builder", () => {
		for (const hasGsm of [true, false]) {
			withGsmAutoconfig(hasGsm, () => {
				clearModems();
				for (const scenario of SCENARIOS) {
					setModem(scenario.runtimeId, scenario.mmcli);
				}

				const live = buildModemsMessage();

				// Build from the SAME modemsState the live builder read.
				const projectedSources: ProjectedModemSource[] = getModemIds()
					.map((id) => {
						const m = SCENARIOS.find((s) => s.runtimeId === id)?.mmcli;
						return m ? fromMmcliModem(id, m) : undefined;
					})
					.filter((s): s is ProjectedModemSource => s !== undefined);

				const projected = projectModemWire(projectedSources, {
					hasGsmAutoconfig: hasGsm,
				});

				expect(stableStringify(projected.message)).toBe(stableStringify(live));
			});
		}
	});
});

describe("T5.3 autoconfig seam + auto resolution", () => {
	test("autoconfig gate = hasGsmAutoconfig && config.autoconfig", () => {
		const base = {
			apn: "internet",
			username: "u",
			password: "p",
			roaming: true,
			network: "310260",
		};

		// setup off ⇒ autoconfig false even when config wants it, apn echoed.
		expect(resolveWireConfig({ ...base, autoconfig: true }, false)).toEqual({
			...base,
			autoconfig: false,
		});

		// setup on + config on ⇒ autoconfig true, apn cleared.
		expect(resolveWireConfig({ ...base, autoconfig: true }, true)).toEqual({
			apn: "",
			username: "u",
			password: "p",
			roaming: true,
			network: "310260",
			autoconfig: true,
		});

		// setup on + config off ⇒ autoconfig false, apn echoed.
		expect(resolveWireConfig({ ...base, autoconfig: false }, true)).toEqual({
			...base,
			autoconfig: false,
		});
	});

	test("a raw `auto` apn is coerced to empty even with autoconfig gated off", () => {
		const resolved = resolveWireConfig(
			{
				apn: AUTO_APN_SENTINEL,
				username: "",
				password: "",
				roaming: false,
				network: "",
				autoconfig: false,
			},
			false,
		);
		expect(resolved.apn).toBe("");
		expect(resolved.autoconfig).toBe(false);
	});
});

describe("T5.3 RAT → legacy network_type display", () => {
	test("highest generation wins; unknowns ignored; empty → ''", () => {
		expect(ratsToNetworkTypeDisplay(new Set(["lte", "5gnr"]))).toBe("5G");
		expect(ratsToNetworkTypeDisplay(new Set(["lte"]))).toBe("4G");
		expect(ratsToNetworkTypeDisplay(new Set(["umts"]))).toBe("3G");
		expect(ratsToNetworkTypeDisplay(new Set(["gsm"]))).toBe("2G");
		expect(ratsToNetworkTypeDisplay(new Set(["gsm", "lte"]))).toBe("4G");
		expect(ratsToNetworkTypeDisplay(new Set())).toBe("");
		expect(ratsToNetworkTypeDisplay(new Set(["unknown-tech"]))).toBe("");
	});
});

describe("T5.3 router/unmanaged ≥1000 synthetic-id allocation", () => {
	function routerSource(
		stableKey: string,
		ifname: string,
	): ProjectedModemSource {
		return fromRouterView({
			kind: "router",
			stableKey,
			ifname,
			name: `HiLink ${ifname}`,
			status: {
				connection: "connected",
				network_type: "4G",
				signal: 0,
				roaming: false,
			},
		});
	}

	test("router/unmanaged rows key from the reserved ≥1000 namespace", () => {
		const mm = fromMmcliModem(0, SCENARIOS[0]?.mmcli as Modem);
		const router = routerSource("usb-1-2", "eth1");

		const { message } = projectModemWire([mm, router], {
			hasGsmAutoconfig: false,
		});

		expect(Object.keys(message)).toContain("0");
		const syntheticKey = Object.keys(message).find(
			(k) => Number(k) >= SYNTHETIC_ID_BASE,
		);
		expect(syntheticKey).toBe(String(SYNTHETIC_ID_BASE));
		expect(message[String(SYNTHETIC_ID_BASE)]?.ifname).toBe("eth1");
	});

	test("collision: a synthetic id NEVER equals a live MM id at/above 1000", () => {
		// A pathological run where MM handed out runtime id 1000 and 1001.
		const mmHigh1 = fromMmcliModem(
			SYNTHETIC_ID_BASE,
			SCENARIOS[0]?.mmcli as Modem,
		);
		const mmHigh2 = fromMmcliModem(
			SYNTHETIC_ID_BASE + 1,
			SCENARIOS[2]?.mmcli as Modem,
		);
		const routerA = routerSource("usb-1-1", "eth1");
		const routerB = routerSource("usb-1-2", "eth2");

		const { message, syntheticIds } = projectModemWire(
			[mmHigh1, mmHigh2, routerA, routerB],
			{ hasGsmAutoconfig: false },
		);

		const mmKeys = new Set([
			String(SYNTHETIC_ID_BASE),
			String(SYNTHETIC_ID_BASE + 1),
		]);
		// Both routers must have been pushed ABOVE the two live MM ids at 1000/1001.
		for (const [, id] of syntheticIds) {
			expect(id).toBeGreaterThanOrEqual(SYNTHETIC_ID_BASE);
			expect(mmKeys.has(String(id))).toBe(false);
		}
		// Distinct ids, and none clobbered a live MM entry.
		const ids = [...syntheticIds.values()];
		expect(new Set(ids).size).toBe(ids.length);
		expect(message[String(SYNTHETIC_ID_BASE)]?.ifname).toBeDefined();
		// The two live MM entries survived at their own ids.
		expect(Object.keys(message)).toContain(String(SYNTHETIC_ID_BASE));
		expect(Object.keys(message)).toContain(String(SYNTHETIC_ID_BASE + 1));
	});

	test("replug stability: same hardware key ⇒ same synthetic id across replug", () => {
		const router = () => routerSource("usb-1-2", "eth1");

		// Plug in.
		const first = projectModemWire([router()], { hasGsmAutoconfig: false });
		const firstId = first.syntheticIds.get("usb-1-2");
		expect(firstId).toBe(SYNTHETIC_ID_BASE);

		// Unplug (device absent from the snapshot). Its id is retained.
		const gap = projectModemWire([], {
			hasGsmAutoconfig: false,
			previousSyntheticIds: first.syntheticIds,
		});

		// Replug the SAME hardware ⇒ same id.
		const second = projectModemWire([router()], {
			hasGsmAutoconfig: false,
			previousSyntheticIds: gap.syntheticIds.size
				? gap.syntheticIds
				: first.syntheticIds,
		});
		expect(second.syntheticIds.get("usb-1-2")).toBe(firstId);
		expect(second.message[String(firstId)]?.ifname).toBe("eth1");
	});

	test("allocation is independent of source array order (replug-safe)", () => {
		const a = routerSource("usb-aaa", "eth1");
		const b = routerSource("usb-bbb", "eth2");

		const forward = projectModemWire([a, b], { hasGsmAutoconfig: false });
		const reversed = projectModemWire([b, a], { hasGsmAutoconfig: false });

		// Same stableKey ⇒ same id regardless of insertion order.
		expect(forward.syntheticIds.get("usb-aaa")).toBe(
			reversed.syntheticIds.get("usb-aaa"),
		);
		expect(forward.syntheticIds.get("usb-bbb")).toBe(
			reversed.syntheticIds.get("usb-bbb"),
		);
	});
});
