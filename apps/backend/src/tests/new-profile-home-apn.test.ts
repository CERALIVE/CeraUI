/**
 * Registration writes a new SIM's profile with its home network's APN only when
 * NetworkManager's Automatic APN would pick a different one, and the wire then
 * says where the APN came from. Driven through `registerModemSafe` with scripted
 * mmcli/nmcli answers, so the NetworkManager write itself is asserted.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as runner from "../helpers/run.ts";
import { resetGsmAutoconfigProbe } from "../modules/modems/gsm-autoconfig.ts";
import { resetGsmConnections } from "../modules/modems/gsm-connections.ts";
import { registerModemSafe } from "../modules/modems/modem-registration.ts";
import {
	fromDbusView,
	fromMmcliModem,
} from "../modules/modems/modem-wire-adapters.ts";
import { withConnectionConfig } from "../modules/modems/modem-wire-producer.ts";
import { resolveWireConfig } from "../modules/modems/modem-wire-projection.ts";
import {
	getModem,
	getModemIds,
	removeModem,
} from "../modules/modems/modems-state.ts";
import { resetProviderDatabaseCache } from "../modules/modems/provider-apn.ts";

const PROVIDERS = `<?xml version="1.0"?>
<serviceproviders format="2.0">
<country code="at">
	<provider>
		<name>Example AT</name>
		<gsm>
			<network-id mcc="232" mnc="17"/>
			<apn value="web"><usage type="internet"/></apn>
		</gsm>
	</provider>
</country>
<country code="de">
	<provider>
		<name>Example DE</name>
		<gsm>
			<network-id mcc="262" mnc="02"/>
			<apn value="web.example.de"><usage type="internet"/></apn>
		</gsm>
	</provider>
</country>
</serviceproviders>`;

const DEVICE_ID = "synthetic-home-apn-device";
const TEMPLATE_UUID = "00000000-0000-4000-8000-0000000000a1";
const NEW_UUID = "00000000-0000-4000-8000-0000000000a2";

let dir = "";
let previousPath: string | undefined;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "home-apn-"));
	await writeFile(path.join(dir, "serviceproviders.xml"), PROVIDERS);
	previousPath = process.env.CERALIVE_PROVIDER_DATABASE_PATH;
	process.env.CERALIVE_PROVIDER_DATABASE_PATH = path.join(
		dir,
		"serviceproviders.xml",
	);
	resetProviderDatabaseCache();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	for (const id of getModemIds()) removeModem(id);
});

afterEach(async () => {
	spyOn(runner, "run").mockRestore();
	if (previousPath === undefined)
		delete process.env.CERALIVE_PROVIDER_DATABASE_PATH;
	else process.env.CERALIVE_PROVIDER_DATABASE_PATH = previousPath;
	resetProviderDatabaseCache();
	resetGsmConnections();
	resetGsmAutoconfigProbe();
	for (const id of getModemIds()) removeModem(id);
	await rm(dir, { recursive: true, force: true });
});

/** Script mmcli and nmcli for one modem; returns the fields of each `connection add`. */
function scriptBoard(opts: {
	simHome: string;
	serving: string;
	model?: string;
	firmware?: string;
	profiles?: Record<string, Record<string, string>>;
}): Array<Record<string, string>> {
	const saved: Record<string, Record<string, string>> = {
		...(opts.profiles ?? {}),
	};
	const added: Array<Record<string, string>> = [];
	spyOn(runner, "run").mockImplementation(async (binary, args) => {
		if (binary === "mmcli" && args[0] === "-K" && args[2] === "0") {
			if (args[1] === "-i")
				return `sim.properties.iccid : sim-new
sim.properties.operator-code : ${opts.simHome}`;
			if (args[1] === "-m")
				return `modem.generic.model : ${opts.model ?? "Example modem"}
modem.generic.revision : ${opts.firmware ?? "1.0"}
modem.generic.state : registered
modem.generic.device-identifier : ${DEVICE_ID}
modem.generic.sim : /org/freedesktop/ModemManager1/SIM/0
modem.3gpp.operator-code : ${opts.serving}
modem.generic.ports.length : 1
modem.generic.ports.value[1] : wwan0 (net)`;
		}
		if (binary === "nmcli") {
			if (args.join(" ") === "--terse --fields uuid,type,state connection show")
				return Object.keys(saved)
					.map((uuid) => `${uuid}:gsm:`)
					.join("\n");
			if (args[0] === "connection" && args[1] === "add") {
				const fields: Record<string, string> = {};
				for (let i = 2; i < args.length; i += 2) {
					const field = args[i];
					const value = args[i + 1];
					if (field !== undefined && value !== undefined) fields[field] = value;
				}
				added.push(fields);
				saved[NEW_UUID] = {
					"gsm.sim-operator-id": "",
					"gsm.username": "",
					"gsm.password": "",
					"gsm.home-only": "no",
					"gsm.network-id": "",
					"gsm.auto-config": "no",
					"connection.autoconnect": "yes",
					"connection.timestamp": "0",
					...fields,
				};
				return `Connection 'gsm' (${NEW_UUID}) successfully added.`;
			}
			const uuid = args.at(-1);
			const profile = uuid === undefined ? undefined : saved[uuid];
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
		throw new Error(`Unexpected command: ${binary} ${args.join(" ")}`);
	});
	return added;
}

test("a roaming SIM's new profile gets its home APN, and the wire says so", async () => {
	const added = scriptBoard({ simHome: "23217", serving: "26202" });

	await registerModemSafe(0);

	expect(added).toHaveLength(1);
	expect(added[0]).toMatchObject({
		"gsm.apn": "web",
		"gsm.auto-config": "no",
		"gsm.sim-operator-id": "23217",
	});
	const modem = getModem(0);
	expect(modem?.config).toMatchObject({ autoconfig: false, apn: "web" });
	const source = modem && fromMmcliModem(0, modem).config;
	expect(source && resolveWireConfig(source, true).apn_source).toBe(
		"provider-database",
	);
});

test("a SIM on its home network gets the same profile as before", async () => {
	const added = scriptBoard({ simHome: "26202", serving: "26202" });

	await registerModemSafe(0);

	expect(added).toHaveLength(1);
	// Unprobed board: Automatic APN is not claimed, so the old default is written.
	expect(added[0]).toMatchObject({
		"gsm.apn": "internet",
		"gsm.auto-config": "no",
	});
	const modem = getModem(0);
	const source = modem && fromMmcliModem(0, modem).config;
	expect(source && "apn_source" in resolveWireConfig(source, true)).toBe(false);
});

test("an automatic template for the same operator does not hand over the wrong choice", async () => {
	const added = scriptBoard({
		simHome: "23217",
		serving: "26202",
		profiles: {
			[TEMPLATE_UUID]: {
				"gsm.device-id": "another-device",
				"gsm.sim-id": "sim-old",
				"gsm.sim-operator-id": "23217",
				"gsm.apn": "",
				"gsm.username": "",
				"gsm.password": "",
				"gsm.home-only": "no",
				"gsm.network-id": "",
				"gsm.auto-config": "yes",
				"connection.autoconnect": "yes",
				"connection.timestamp": "0",
			},
		},
	});

	await registerModemSafe(0);

	expect(added).toHaveLength(1);
	expect(added[0]).toMatchObject({
		"gsm.apn": "web",
		"gsm.auto-config": "no",
	});
});

test("a manual template for the same operator is still copied", async () => {
	const added = scriptBoard({
		simHome: "23217",
		serving: "26202",
		profiles: {
			[TEMPLATE_UUID]: {
				"gsm.device-id": "another-device",
				"gsm.sim-id": "sim-old",
				"gsm.sim-operator-id": "23217",
				"gsm.apn": "typed.by.someone",
				"gsm.username": "",
				"gsm.password": "",
				"gsm.home-only": "no",
				"gsm.network-id": "",
				"gsm.auto-config": "no",
				"connection.autoconnect": "yes",
				"connection.timestamp": "0",
			},
		},
	});

	await registerModemSafe(0);

	expect(added).toHaveLength(1);
	expect(added[0]).toMatchObject({ "gsm.apn": "typed.by.someone" });
});

test("the D-Bus row picks the hint up from the registered modem", async () => {
	const added = scriptBoard({ simHome: "23217", serving: "26202" });
	await registerModemSafe(0);
	expect(added).toHaveLength(1);

	// The live D-Bus row arrives without a config; the producer joins the
	// mmcli-side profile by runtime id, hint included.
	const joined = withConnectionConfig({
		runtimeId: 0,
		ifname: "wwan0",
		mmState: "registered",
		registration: { status: "roaming", activeRats: new Set<string>() },
		signal: 70,
		supportedNetworkTypes: ["4g"],
		activeNetworkType: "4g",
	});
	const source = fromDbusView(joined);
	expect(
		source.config && resolveWireConfig(source.config, true).apn_source,
	).toBe("provider-database");
});

test("a template pinned to another network is judged by that network", async () => {
	// Registered on its home network, but the template pins 26202: NetworkManager
	// would look up 26202 and send its APN, so the home APN is written.
	const added = scriptBoard({
		simHome: "23217",
		serving: "23217",
		profiles: {
			[TEMPLATE_UUID]: {
				"gsm.device-id": "another-device",
				"gsm.sim-id": "sim-old",
				"gsm.sim-operator-id": "23217",
				"gsm.apn": "",
				"gsm.username": "",
				"gsm.password": "",
				"gsm.home-only": "no",
				"gsm.network-id": "26202",
				"gsm.auto-config": "yes",
				"connection.autoconnect": "yes",
				"connection.timestamp": "0",
			},
		},
	});

	await registerModemSafe(0);

	expect(added[0]).toMatchObject({ "gsm.apn": "web", "gsm.auto-config": "no" });
});
