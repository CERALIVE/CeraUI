import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as runner from "../helpers/run.ts";
import { resetGsmAutoconfigProbe } from "../modules/modems/gsm-autoconfig.ts";
import { resetGsmConnections } from "../modules/modems/gsm-connections.ts";
import { registerModemSafe } from "../modules/modems/modem-registration.ts";
import {
	getModem,
	getModemIds,
	removeModem,
} from "../modules/modems/modems-state.ts";

const DEVICE_ID = "synthetic-twin-device";
const UUID_A = "00000000-0000-4000-8000-000000000001";
const UUID_B = "00000000-0000-4000-8000-000000000002";
const profiles: Record<string, Record<string, string>> = {
	[UUID_A]: {
		"gsm.device-id": DEVICE_ID,
		"gsm.sim-id": "sim-a",
		"gsm.sim-operator-id": "",
		"gsm.apn": "apn-a",
		"gsm.username": "",
		"gsm.password": "",
		"gsm.home-only": "yes",
		"gsm.network-id": "",
		"gsm.auto-config": "no",
		"connection.autoconnect": "yes",
		"connection.timestamp": "0",
	},
	[UUID_B]: {
		"gsm.device-id": DEVICE_ID,
		"gsm.sim-id": "sim-b",
		"gsm.sim-operator-id": "",
		"gsm.apn": "apn-b",
		"gsm.username": "",
		"gsm.password": "",
		"gsm.home-only": "yes",
		"gsm.network-id": "",
		"gsm.auto-config": "no",
		"connection.autoconnect": "yes",
		"connection.timestamp": "0",
	},
};

beforeEach(() => {
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	for (const id of getModemIds()) removeModem(id);
});

afterEach(() => {
	spyOn(runner, "run").mockRestore();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	for (const id of getModemIds()) removeModem(id);
});

test("twins sharing a device identifier keep distinct SIM profiles, including after a SIM swap", async () => {
	let sims = ["sim-a", "sim-b"];
	const unexpected: string[] = [];
	spyOn(runner, "run").mockImplementation(async (binary, args) => {
		if (binary === "mmcli" && args[0] === "-K") {
			const id = args[2];
			if (id === "0" || id === "1") {
				if (args[1] === "-i")
					return `sim.properties.iccid : ${sims[Number(id)]}`;
				if (args[1] === "-m")
					return `modem.generic.model : QMI twin
modem.generic.state : enabled
modem.generic.device-identifier : ${DEVICE_ID}
modem.generic.sim : /org/freedesktop/ModemManager1/SIM/${id}
modem.generic.ports.length : 1
modem.generic.ports.value[1] : wwan${id} (net)`;
			}
		}
		if (binary === "nmcli") {
			if (args.join(" ") === "--terse --fields uuid,type,state connection show")
				return `${UUID_A}:gsm:\n${UUID_B}:gsm:`;
			const uuid = args.at(-1);
			const profile = uuid === undefined ? undefined : profiles[uuid];
			if (
				profile &&
				args.slice(0, 5).join(" ") ===
					"--terse --escape no --show-secrets --get-values"
			) {
				const fields = args[5]?.split(",");
				if (fields?.every((field) => field in profile))
					return fields.map((field) => profile[field]).join("\n");
			}
		}
		const command = `${binary} ${args.join(" ")}`;
		unexpected.push(command);
		throw new Error(`Unexpected command: ${command}`);
	});

	await registerModemSafe(0);
	await registerModemSafe(1);
	expect([getModem(0)?.config, getModem(1)?.config]).toEqual([
		expect.objectContaining({ conn: UUID_A, apn: "apn-a" }),
		expect.objectContaining({ conn: UUID_B, apn: "apn-b" }),
	]);

	// Keep device identities and the saved inventory fixed; move only the SIMs.
	sims = ["sim-b", "sim-a"];
	removeModem(0);
	removeModem(1);
	await registerModemSafe(0);
	await registerModemSafe(1);
	expect([getModem(0)?.config, getModem(1)?.config]).toEqual([
		expect.objectContaining({ conn: UUID_B, apn: "apn-b" }),
		expect.objectContaining({ conn: UUID_A, apn: "apn-a" }),
	]);
	expect(unexpected).toEqual([]);
});
