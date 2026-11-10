import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { modemConfigInputSchema } from "@ceraui/rpc/schemas";
import * as mockService from "../mocks/mock-service.ts";
import { getConfigFilePath } from "../modules/config.ts";
import { buildModemsWireMessage } from "../modules/modems/modem-status.ts";
import {
	applyModemConfig,
	defaultModemApplyDeps,
} from "../modules/modems/modems.ts";
import {
	getModem,
	getModems,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import * as networkManager from "../modules/network/network-manager.ts";
import { StatusSchema } from "../modules/remote-control/protocol.ts";
import {
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { object } from "./helpers/remote-privacy-cases.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";

usePrivacyConfig();
let previous: ReturnType<typeof getModems>;
beforeEach(() => {
	previous = { ...getModems() };
	for (const id of Object.keys(getModems())) removeModem(Number(id));
	spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
});
afterEach(() => {
	for (const id of Object.keys(getModems())) removeModem(Number(id));
	for (const [id, modem] of Object.entries(previous))
		setModem(Number(id), modem);
	resetStatusRelay();
	mock.restore();
});

for (const field of ["username", "password"] as const) {
	test(`remote APN ${field} read and real profile save retain the owner's value`, async () => {
		const saved = {
			conn: "11ab26e2",
			autoconfig: false,
			apn: "carrier.example",
			username: "owner-apn-user",
			password: "owner-apn-password",
			roaming: false,
			network: "",
		};
		setModem(2, {
			ifname: "wwan0",
			name: "Round-trip modem",
			sim_network: "Carrier",
			network_type: {
				supported: { "4g3g": { allowed: "3g|4g", preferred: "4g" } },
				active: "4g3g",
			},
			config: { ...saved },
			status: {
				connection: "disconnected",
				network_type: "4g",
				signal: 80,
				roaming: false,
			},
		});
		const local = buildModemsWireMessage();
		const before = JSON.stringify(local);
		const frames: unknown[] = [];
		setControlChannel({
			isConnected: () => true,
			sendFrame: (frame) => frames.push(frame),
		});
		relayStatusToGateway("status", { modems: local }, 1);
		const modems = StatusSchema.parse(frames[0]).payload?.modems;
		if (!object(modems) || !object(modems["2"]) || !object(modems["2"].config))
			throw new Error("missing remote APN config");
		const config = modems["2"].config;

		// These are ModemConfigDialog's existing form defaults and its public
		// input schema; the actual profile writer below owns normalization.
		const input = modemConfigInputSchema.parse({
			device: "2",
			network_type: "4g3g",
			roaming: Boolean(config.roaming),
			network: config.network ?? "",
			autoconfig: config.autoconfig ?? false,
			apn: config.apn ?? "",
			username: config.username ?? "",
			password: config.password ?? "",
		});
		expect(input[field]).toBe(saved[field]);
		expect(JSON.stringify(local)).toBe(before);
		const replacement = `updated-${field}-owner-value`;
		input[field] = replacement;
		const profile = join(dirname(getConfigFilePath()), "nm-profile.json");
		spyOn(networkManager, "nmConnSetFields").mockImplementation(
			async (_uuid, fields) => {
				await writeFile(profile, JSON.stringify(fields));
				return true;
			},
		);
		const outcome = await applyModemConfig(
			{
				...input,
				device: Number(input.device),
				roaming: input.roaming ?? false,
				autoconfig: input.autoconfig ?? false,
			},
			{
				...defaultModemApplyDeps,
				readConnectionHold: async () => "idle",
				enforceAcrossProfiles: async () => 0,
				disconnect: async () => true,
				setNetworkTypes: async () => true,
				autoconfigSupported: () => false,
			},
		);

		expect(outcome).toEqual({ ok: true, reconnected: false });
		expect(JSON.parse(await readFile(profile, "utf8"))[`gsm.${field}`]).toBe(
			replacement,
		);
		expect(getModem(2)?.config?.[field]).toBe(replacement);
		expect(buildModemsWireMessage()["2"]).toHaveProperty(
			`config.${field}`,
			replacement,
		);
	});
}
