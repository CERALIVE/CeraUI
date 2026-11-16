import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";
import * as runner from "../helpers/run.ts";
import * as mockService from "../mocks/mock-service.ts";
import { resetGsmAutoconfigProbe } from "../modules/modems/gsm-autoconfig.ts";
import { resetGsmConnections } from "../modules/modems/gsm-connections.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import {
	getModem,
	getModemIds,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { setup } from "../modules/setup.ts";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";
import { configureModemProcedure } from "../rpc/procedures/modems.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

const UUID = "00000000-0000-4000-8000-000000000001";
const originalSupport = setup.has_gsm_autoconfig;
const originalJournal = process.env.CERALIVE_MODEM_MUTATION_DIR;
let scratch: string;
let profile: Record<string, string>;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "configure-normalization-"));
	process.env.CERALIVE_MODEM_MUTATION_DIR = scratch;
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	profile = {
		"gsm.device-id": "synthetic-device",
		"gsm.sim-id": "synthetic-sim",
		"gsm.auto-config": "no",
		"gsm.apn": "previous.apn",
		"gsm.username": "",
		"gsm.password": "",
		"gsm.home-only": "yes",
		"gsm.network-id": "",
		"gsm.sim-operator-id": "",
	};
	setModem(0, {
		ifname: "wwan0",
		name: "Synthetic modem",
		sim_network: "",
		network_type: {
			supported: { "4g": { allowed: "4g", preferred: "none" } },
			active: "4g",
		},
		config: {
			conn: UUID,
			autoconfig: false,
			apn: "previous.apn",
			username: "",
			password: "",
			roaming: false,
			network: "310260",
		},
	});
	setModemIdPathReader(async () => new Map([["wwan0", "synthetic-port"]]));
	await refreshModemIdPaths();
	spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
	spyOn(runner, "run").mockImplementation(async (binary, args) => {
		if (binary === "nmcli") {
			if (args[0] === "con" && args[1] === "modify" && args[2] === UUID) {
				for (let index = 3; index < args.length; index += 2) {
					const key = args[index];
					const value = args[index + 1];
					if (key === undefined || value === undefined)
						throw new Error("Incomplete NM property");
					profile[key] = value;
				}
				return "";
			}
			if (args.join(" ") === "--terse --fields uuid,type,state connection show")
				return `${UUID}:gsm:`;
			if (args[4] === "--get-values" && args.at(-1) === UUID)
				return (args[5] ?? "")
					.split(",")
					.map((field) => profile[field] ?? "")
					.join("\n");
		}
		throw new Error(`Unexpected command: ${binary} ${args.join(" ")}`);
	});
});

afterEach(async () => {
	mock.restore();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	setModemIdPathReader(null);
	resetModemWireProducer();
	for (const id of getModemIds()) removeModem(id);
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	if (originalSupport === undefined) delete setup.has_gsm_autoconfig;
	else setup.has_gsm_autoconfig = originalSupport;
	if (originalJournal === undefined)
		delete process.env.CERALIVE_MODEM_MUTATION_DIR;
	else process.env.CERALIVE_MODEM_MUTATION_DIR = originalJournal;
	await rm(scratch, { recursive: true, force: true });
});

for (const scenario of [
	{
		name: "unsupported automatic APN reports the manual profile actually written",
		supported: false,
		automatic: true,
		expectedAutomatic: false,
		expectedApn: "internet",
		expectedUser: "carrier-user",
		expectedPassword: "carrier-secret",
	},
	{
		name: "automatic APN clears stale APN and authentication before writing",
		supported: true,
		automatic: true,
		expectedAutomatic: true,
		expectedApn: "",
		expectedUser: "",
		expectedPassword: "",
	},
	{
		name: "manual APN reaches NetworkManager without literal quotes",
		supported: true,
		automatic: false,
		expectedAutomatic: false,
		expectedApn: "internet",
		expectedUser: "carrier-user",
		expectedPassword: "carrier-secret",
	},
] as const) {
	test(scenario.name, async () => {
		setup.has_gsm_autoconfig = scenario.supported;

		const result = await call(
			configureModemProcedure,
			{
				device: "0",
				network_type: "4g",
				roaming: false,
				network: "310260",
				autoconfig: scenario.automatic,
				apn: "internet",
				username: "carrier-user",
				password: "carrier-secret",
			},
			{ context: makeRpcContext() },
		);

		expect(result.success).toBe(true);
		expect(profile).toMatchObject({
			"gsm.auto-config": scenario.expectedAutomatic ? "yes" : "no",
			"gsm.apn": scenario.expectedApn,
			"gsm.username": scenario.expectedUser,
			"gsm.password": scenario.expectedPassword,
			"gsm.password-flags": scenario.expectedPassword === "" ? "4" : "0",
			"gsm.home-only": "yes",
			"gsm.network-id": "",
		});
		expect(result.applied).toEqual({
			device: "0",
			network_type: "4g",
			roaming: false,
			network: "",
			autoconfig: scenario.expectedAutomatic,
			apn: scenario.expectedApn,
			username: scenario.expectedUser,
			password: scenario.expectedPassword,
		});
		expect(getModem(0)?.config).toMatchObject({
			autoconfig: scenario.expectedAutomatic,
			apn: scenario.expectedApn,
			username: scenario.expectedUser,
			password: scenario.expectedPassword,
			network: "",
		});
	});
}
