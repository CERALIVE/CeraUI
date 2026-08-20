/**
 * The 3G/4G/5G selector reports the radio's mode, and a refused write says so.
 *
 * Board investigation on a Rock 5B+ (192.168.78.132, Quectel RM530N-GL, mmcli
 * 1.24.2, 2026-08-16). The apply path itself is real — five requested modes were
 * driven through `modems.configure` and every one landed
 * (`--set-allowed-modes=3g|4g|5g --set-preferred-mode=5g` →
 * `modem.generic.current-modes: allowed: 3g, 4g, 5g; preferred: 5g`). Two
 * defects sat around it:
 *
 *  1. `refreshModemStatus` carried DISCOVERY's `network_type` forward untouched,
 *     even though `current-modes` rides every `-K` payload it already fetches.
 *     Measured: the modem was moved to `allowed: 3g`, and 40 s later — past the
 *     30 s status poll — `modems.getAll` still answered `active: "5g4g"`. The
 *     value was latched for the process lifetime.
 *  2. `applyModemConfig` decides whether to write the radio at all by comparing
 *     the request against that latched value, so saving the mode the dialog was
 *     SHOWING skipped mmcli entirely. Measured: `configure(network_type:"5g4g")`
 *     answered `{"success":true}` while the modem stayed on `allowed: 3g`.
 *
 * And a third, adjacent to both: a `--set-allowed-modes` the modem refuses left
 * `applyModemConfig` returning `ok:true`, because the outcome was said to ride
 * "the ordinary configure-echo" — an echo that parrots the REQUEST.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { ModemInfo } from "../modules/modems/mmcli.ts";
import {
	deriveNetworkTypes,
	mergeRefreshedModem,
} from "../modules/modems/modem-registration.ts";
import {
	applyModemConfig,
	type ModemApplyDeps,
} from "../modules/modems/modems.ts";
import {
	getModem,
	getModems,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";

/** Verbatim `mmcli -K -m 2` fields from the bench Quectel RM530N-GL. */
const BOARD_SUPPORTED_MODES = [
	"allowed: 3g; preferred: none",
	"allowed: 4g; preferred: none",
	"allowed: 3g, 4g; preferred: 4g",
	"allowed: 3g, 4g; preferred: 3g",
	"allowed: 5g; preferred: none",
	"allowed: 4g, 5g; preferred: 5g",
	"allowed: 4g, 5g; preferred: 4g",
	"allowed: 3g, 5g; preferred: 5g",
	"allowed: 3g, 5g; preferred: 3g",
	"allowed: 3g, 4g, 5g; preferred: 5g",
	"allowed: 3g, 4g, 5g; preferred: 4g",
	"allowed: 3g, 4g, 5g; preferred: 3g",
];

function boardPayload(currentModes?: string): ModemInfo {
	return {
		"modem.generic.sim": "/org/freedesktop/ModemManager1/SIM/0",
		"modem.generic.state": "searching",
		"modem.generic.ports": ["cdc-wdm0 (qmi)", "wwan0 (net)"],
		"modem.generic.model": "RM530N-GL",
		...(currentModes !== undefined
			? { "modem.generic.current-modes": currentModes }
			: {}),
		"modem.generic.supported-modes": BOARD_SUPPORTED_MODES,
		"modem.generic.equipment-identifier": "867978050016855",
		"modem.generic.device-identifier":
			"b59f0594669e9a71267b592f4bfeff95d5d8f40b",
		"modem.generic.access-technologies": [],
		"modem.generic.signal-quality.value": 81,
		"modem.3gpp.registration-state": "searching",
	} as unknown as ModemInfo;
}

function latchedModem(): Modem {
	return {
		ifname: "wwan0",
		name: "RM530N-GL - 16855",
		sim_network: "Movistar",
		network_type: {
			supported: { "5g4g": { allowed: "4g|5g", preferred: "5g" } },
			active: "5g4g",
		},
		config: {
			conn: "11ab26e2",
			autoconfig: true,
			apn: "",
			username: "",
			password: "",
			roaming: false,
			network: "",
		},
	};
}

describe("the mode block is DERIVED from every payload, never carried forward", () => {
	test("the board's own supported list folds to the labels the dialog offers", () => {
		const derived = deriveNetworkTypes(
			boardPayload("allowed: 3g, 4g; preferred: 4g"),
		);

		expect(derived).toBeDefined();
		expect(Object.keys(derived?.supported ?? {})).toEqual([
			"3g",
			"4g",
			"4g3g",
			"5g",
			"5g4g",
			"5g3g",
			"5g4g3g",
		]);
		expect(derived?.active).toBe("4g3g");
		// Two board rows share the `4g3g` label; the higher preference wins, so the
		// mmcli flags the label resolves to are the ones the operator asked for.
		expect(derived?.supported["4g3g"]).toEqual({
			allowed: "3g|4g",
			preferred: "4g",
		});
	});

	test("a mode changed outside this backend is picked up on the next read", () => {
		expect(
			deriveNetworkTypes(boardPayload("allowed: 3g; preferred: none"))?.active,
		).toBe("3g");
		expect(
			deriveNetworkTypes(boardPayload("allowed: 3g, 4g, 5g; preferred: 5g"))
				?.active,
		).toBe("5g4g3g");
	});

	test("a current mode missing from the supported list is still offered", () => {
		const derived = deriveNetworkTypes({
			...boardPayload("allowed: 2g; preferred: none"),
			"modem.generic.supported-modes": ["allowed: 4g; preferred: none"],
		} as unknown as ModemInfo);

		expect(derived?.active).toBe("2g");
		expect(derived?.supported["2g"]).toEqual({
			allowed: "2g",
			preferred: "none",
		});
	});

	test("a payload that cannot answer withholds, so the caller keeps what it had", () => {
		const noModeFields = { ...boardPayload() } as Record<string, unknown>;
		delete noModeFields["modem.generic.supported-modes"];

		expect(deriveNetworkTypes(noModeFields as ModemInfo)).toBeUndefined();
		expect(deriveNetworkTypes(boardPayload("not a mode line"))).toBeUndefined();
	});
});

describe("a status refresh replaces the latched mode", () => {
	test("the merged modem reports the radio's mode, not discovery's", () => {
		const merged = mergeRefreshedModem(
			latchedModem(),
			boardPayload("allowed: 3g; preferred: none"),
		);

		expect(merged.network_type.active).toBe("3g");
		expect(Object.keys(merged.network_type.supported)).toContain("5g4g3g");
	});

	test("an unreadable payload leaves the previous mode standing", () => {
		const merged = mergeRefreshedModem(
			latchedModem(),
			boardPayload("not a mode line"),
		);

		expect(merged.network_type).toEqual(latchedModem().network_type);
	});

	test("everything the refresh does not own survives it", () => {
		const merged = mergeRefreshedModem(
			latchedModem(),
			boardPayload("allowed: 4g; preferred: none"),
		);

		expect(merged.ifname).toBe("wwan0");
		expect(merged.name).toBe("RM530N-GL - 16855");
		expect(merged.config?.conn).toBe("11ab26e2");
		expect(merged.status?.connection).toBe("searching");
	});
});

describe("a refused radio write is never reported as saved", () => {
	const MSG = {
		device: 2,
		network_type: "5g4g3g",
		roaming: false,
		network: "",
		autoconfig: true,
		apn: "",
		username: "",
		password: "",
	};

	function deps(setResult: boolean | undefined): ModemApplyDeps {
		return {
			writeConnection: async () => true,
			readConnectionHold: async () => "idle",
			enforceAcrossProfiles: async () => 0,
			disconnect: async () => true,
			setNetworkTypes: async () => setResult,
			autoconfigSupported: () => true,
		};
	}

	beforeEach(() => {
		for (const id of Object.keys(getModems())) removeModem(Number(id));
		const modem = latchedModem();
		modem.network_type.supported["5g4g3g"] = {
			allowed: "3g|4g|5g",
			preferred: "5g",
		};
		setModem(2, modem);
	});

	test("mmcli refusing the mode fails the save", async () => {
		expect(await applyModemConfig(MSG, deps(false))).toEqual({
			ok: false,
			reason: "write_failed",
		});
		expect(getModem(2)?.network_type.active).toBe("5g4g");
	});

	test("an mmcli spawn that threw fails the save too", async () => {
		expect(await applyModemConfig(MSG, deps(undefined))).toEqual({
			ok: false,
			reason: "write_failed",
		});
	});

	test("a mode the modem accepted still saves", async () => {
		expect(await applyModemConfig(MSG, deps(true))).toEqual({
			ok: true,
			reconnected: false,
		});
		expect(getModem(2)?.network_type.active).toBe("5g4g3g");
	});
});
