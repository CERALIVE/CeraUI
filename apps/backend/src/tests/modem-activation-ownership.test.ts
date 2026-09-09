import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as runner from "../helpers/run.ts";
import { refreshModemStatus } from "../modules/modems/modem-registration.ts";
import {
	getModem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";

// Rock 2026-09-09 01:39Z: gsm-1 failed unknown-apn, then pdn-ipv4-call-throttled.
// These are the observed MM fields; subscriber identifiers are deliberately omitted.
const REGISTERED_QUECTEL = `modem.generic.model : RM530N-GL
modem.generic.primary-port : cdc-wdm2
modem.generic.unlock-required : sim-pin2
modem.generic.state : registered
modem.generic.state-failed-reason : --
modem.generic.power-state : on
modem.3gpp.registration-state : home
modem.3gpp.packet-service-state : attached
modem.generic.sim : /org/freedesktop/ModemManager1/SIM/1`;
const CONNECTION = "d848da09-f700-4530-b888-be8b99ec8c85";

describe("NetworkManager owns automatic cellular activation", () => {
	afterEach(() => {
		spyOn(runner, "run").mockRestore();
		removeModem(2);
	});

	for (const nmState of ["", "activating", "activated"]) {
		test(`status polls never bypass NM retry policy when GENERAL.STATE is ${nmState || "empty"}`, async () => {
			// Given the registered SIM-present row and the failing profile on Rock.
			setModem(2, {
				ifname: "wwu1u4u4i4",
				name: "RM530N-GL",
				sim_network: "Movistar",
				network_type: { supported: {}, active: null },
				config: {
					conn: CONNECTION,
					autoconfig: false,
					apn: '"internet"',
					username: "",
					password: "",
					roaming: true,
					network: "",
				},
			});
			const commands: string[][] = [];
			spyOn(runner, "run").mockImplementation(async (binary, args) => {
				commands.push([binary, ...args]);
				if (binary === "mmcli") return REGISTERED_QUECTEL;
				if (binary === "nmcli" && args.includes("--get-values")) return nmState;
				throw new Error("Error: Connection activation failed: Unknown error");
			});

			// When twelve retained polls see the same refused-but-registered modem.
			for (let poll = 0; poll < 12; poll++) await refreshModemStatus(2);

			// Then observation stays live without issuing explicit activation retries.
			expect(commands.filter(([binary]) => binary === "mmcli")).toHaveLength(
				12,
			);
			expect(commands.filter(([binary]) => binary === "nmcli")).toEqual([]);
			expect(getModem(2)?.status?.connection).toBe("registered");
			expect(getModem(2)?.sim_presence).toBe("present");
			expect(getModem(2)?.config?.apn).toBe('"internet"');
		});
	}
});
