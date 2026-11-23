import { expect, spyOn, test } from "bun:test";
import * as runner from "../../../src/helpers/run.ts";
import * as nm from "../../../src/modules/network/network-manager.ts";
import * as restore from "../../../src/modules/wifi/wifi-adapter-mode-restore.ts";
import * as devices from "../../../src/modules/wifi/wifi-device-list.ts";
import * as activation from "../../../src/modules/wifi/wifi-hotspot-activation.ts";
import * as stop from "../../../src/modules/wifi/wifi-hotspot-config.ts";
import { getWifiIdToMacAddress } from "../../../src/modules/wifi/wifi-interfaces.ts";
import { MAC, PROFILE } from "../../../src/tests/helpers/wifi-autoconnect-fixture.ts";
import { ACTIVE_PATH } from "../../../src/tests/helpers/wifi-active-observation.ts";
import { hotspotLossFixture } from "../../../src/tests/helpers/wifi-hotspot-loss-fixture.ts";
import * as radio from "./first-ap-radio.ts";
import { nativeRecoveryCase } from "./first-ap-recovery.ts";

const f = hotspotLossFixture();
const stopBackend = stop.wifiHotspotStop;

test("native qualification drives observed loss, public Stop and actual owner retry exhaustion", async () => {
	await f.startRestore();
	const row = f.row();
	spyOn(devices, "wifiDeviceListGetInetAddress").mockReturnValue("192.0.2.1");
	spyOn(restore, "startWifiAdapterModeRestore").mockReturnValue(() => {});
	spyOn(radio, "observeSavedProfileRadio").mockImplementation(async () => {
		await f.discover();
	});
	spyOn(Bun, "sleep").mockImplementation(async () => {
		await f.advance(3000);
	});
	const runSpy = spyOn(runner, "run");
	const original = runSpy.getMockImplementation();
	if (!original) throw new Error("Missing fixture NM boundary");
	runSpy.mockImplementation(async (binary, args, options) => {
		if (binary === "nmcli" && args.slice(0, 2).join(" ") === "connection down") {
			f.lose();
			return "Connection successfully deactivated";
		}
		return original(binary, args, options);
	});
	spyOn(nm, "nmDeviceProp").mockImplementation(async (ifname, fields) => {
		if (fields.startsWith("GENERAL.STATE,GENERAL.CON-UUID")) {
			const active = (await nm.nmDevices("device,type,state,con-uuid"))
				?.map(nm.nmcliParseSep)
				.find(([name]) => name === ifname)?.[3];
			return [active ? "100" : "30", active ?? "", active ? ACTIVE_PATH : ""];
		}
		return ["Policy", "Radio", "yes", "no", "yes"];
	});
	spyOn(activation, "wifiHotspotStart").mockImplementation(async () => f.start());
	spyOn(stop, "wifiHotspotStop").mockImplementation(async (request) => {
		const current = f.row();
		const ids = getWifiIdToMacAddress();
		const previous = ids[current.id];
		ids[current.id] = MAC;
		try {
			return await stopBackend(request, {
				...stop.defaultHotspotStopDeps,
				nmDisconnect: async () => {
					f.lose();
					return true;
				},
				rescan: async () => undefined,
				broadcastState: () => undefined,
				setDupIpSuppression: () => undefined,
			});
		} finally {
			if (previous === undefined) delete ids[current.id];
			else ids[current.id] = previous;
		}
	});
	const phases: string[] = [];
	let failedStartAt = -1;
	await nativeRecoveryCase(
		{ uuid: PROFILE, owner: MAC, ifname: row.ifname },
		row,
		{
			schedule: async () => undefined,
			block: async (uuid) => {
				if (uuid !== undefined) failedStartAt = f.attempts.length;
				f.acceptsActivation = uuid === undefined;
			},
			events: async () => f.attempts.map(() => ({ kind: "up", uuid: PROFILE })),
			foreign: async () => Buffer.alloc(0),
			close: async () => undefined,
		},
		(phase) => phases.push(phase),
	);

	expect(phases).toContain("recovery.loss");
	expect(phases).toContain("recovery.stop");
	expect(phases).toContain("recovery.exhaust");
	expect(f.attempts.slice(failedStartAt)).toEqual(["wlan0", "wlan0", "wlan0"]);
});
