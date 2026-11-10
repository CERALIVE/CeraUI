import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hotspotConfigInputSchema,
	wifiInterfaceSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	PROTOCOL_VERSION,
	StatusSchema,
} from "../modules/remote-control/protocol.ts";
import {
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { defaultHotspotConfigDeps } from "../modules/wifi/wifi-hotspot-config.ts";
import { hotspotConfigureProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { object } from "./helpers/remote-privacy-cases.ts";
import { wifiFrameFixture } from "./helpers/wifi-frame-fixture.ts";

test("remote status exposes the live hotspot password and a new password reaches the existing config writer unchanged", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "remote-hotspot-roundtrip-"));
	const fixture = await wifiFrameFixture(true, true);
	try {
		const frames: unknown[] = [];
		setControlChannel({
			isConnected: () => true,
			sendFrame: (frame) => frames.push(frame),
		});
		const local = wifiBuildMsg();
		const before = JSON.stringify(local);
		relayStatusToGateway("status", { wifi: local }, 1);
		const status = StatusSchema.parse(frames[0]);
		expect(status.v).toBe(PROTOCOL_VERSION);
		if (!object(status.payload?.wifi)) throw new Error("missing remote Wi-Fi");
		const remote = wifiInterfaceSchema.parse(status.payload.wifi["0"]);
		expect(remote.hotspot?.password).toBe(fixture.row.hotspot.password);
		expect(remote).not.toHaveProperty("incarnation");
		expect(JSON.stringify(local)).toBe(before);

		const password = "delegate-updated-password";
		const input = hotspotConfigInputSchema.parse({
			device: "0",
			name: remote.hotspot?.name,
			password,
			channel: remote.hotspot?.channel,
		});
		const profile = join(scratch, "nm-hotspot.json");
		const identity = join(scratch, "hotspot-identity.json");
		spyOn(defaultHotspotConfigDeps, "getCapabilities").mockReturnValue(
			undefined,
		);
		spyOn(defaultHotspotConfigDeps, "nmConnSetFields").mockImplementation(
			async (_uuid, fields) => {
				await writeFile(profile, JSON.stringify(fields));
				return true;
			},
		);
		spyOn(defaultHotspotConfigDeps, "nmConnect").mockResolvedValue(true);
		spyOn(defaultHotspotConfigDeps, "wifiUpdateSavedConns").mockResolvedValue();
		spyOn(defaultHotspotConfigDeps, "broadcastState").mockImplementation(
			() => undefined,
		);
		spyOn(defaultHotspotConfigDeps, "rememberCredentials").mockImplementation(
			(_mac, credentials) => {
				writeFileSync(identity, JSON.stringify(credentials));
			},
		);

		const result = await call(hotspotConfigureProcedure, input, {
			context: fixture.context,
		});
		await fixture.configReceived;

		expect(result).toEqual({ success: true });
		expect(
			JSON.parse(await readFile(profile, "utf8"))[
				"802-11-wireless-security.psk"
			],
		).toBe(password);
		expect(JSON.parse(await readFile(identity, "utf8")).password).toBe(
			password,
		);
		expect(fixture.frames.at(-1)).toContain('"success":true');
	} finally {
		resetStatusRelay();
		await fixture.restore();
		await rm(scratch, { recursive: true, force: true });
	}
});
