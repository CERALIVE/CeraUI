import { afterEach, expect, spyOn, test } from "bun:test";
import * as nm from "../modules/network/network-manager.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import {
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import { quiesceHotspotAutoconnect } from "../modules/wifi/wifi-autoconnect-policy.ts";
import {
	addWifiInterface,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import {
	autoconnectFixture,
	MAC,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();
afterEach(resetBootReadiness);
const owner = `${MAC}@phy0`;
const uuid = `${PROFILE}-0`;

async function revokedTwin(): Promise<Record<string, string>> {
	resetHotspotCredentialsForTest();
	removeWifiInterface(MAC);
	for (const i of [0, 1]) {
		const row = {
			...f.row(),
			id: i,
			ifname: `wlan${i}`,
			degradedReason: "permanent-mac-unresolved" as const,
			hotspot: { ...f.row().hotspot },
		};
		delete row.hotspot.conn;
		f.profiles.set(`${PROFILE}-${i}`, {
			"802-11-wireless.mode": "ap",
			"connection.autoconnect": "no",
			"connection.interface-name": row.ifname,
			"802-11-wireless.mac-address": MAC,
			"match.path": `phy${i}`,
		});
		f.witnesses.set(row.ifname, {
			ifindex: 3 + 2 * i,
			phy: `/sys/devices/policy/phy${i}`,
			mac: MAC,
			path: `phy${i}`,
		});
		addWifiInterface(`limited:${3 + 2 * i}:0`, row);
		getWifiIdToMacAddress()[i] = `limited:${3 + 2 * i}:0`;
		rememberHotspotCredentials(`${MAC}@phy${i}`, {
			ssid: `Twin ${i}`,
			password: "fixture-password",
			conn: `${PROFILE}-${i}`,
		});
		f.persistMode(`${MAC}@phy${i}`, "hotspot");
	}
	await f.sample();
	await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map());
	expect(wifiAdapterLockKey("limited:3:0")).toBe(owner);
	const profile = f.profiles.get(uuid);
	if (!profile) throw new Error("Missing first twin profile");
	profile["match.path"] = "phy1";
	await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map());
	expect(wifiAdapterLockKey("limited:3:0")).toBe("limited:3:0");
	profile["match.path"] = "phy0";
	profile["connection.autoconnect"] = "yes";
	f.persistMode(owner, "station");
	f.effects.length = 0;
	return profile;
}

test.each([0, 1])(
	"r7 discovery rechecks retained authority after profile read, held twin=%s",
	async (heldTwin) => {
		const profile = await revokedTwin();
		f.list([`wlan0:wifi:connected:${uuid}`, "wlan1:wifi:disconnected:"]);
		const disconnected: string[] = [];
		spyOn(nm, "nmDisconnect").mockImplementation(async (target) => {
			disconnected.push(target);
			f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
			return true;
		});
		const read = nm.nmConnGetFields;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const admitted = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let paused = false;
		let operationHeld = false;
		spyOn(nm, "nmConnGetFields").mockImplementation(async (target, fields) => {
			if (
				!paused &&
				target === uuid &&
				fields.includes("connection.autoconnect")
			) {
				paused = true;
				entered.resolve();
				await release.promise;
			}
			return read(target, fields);
		});
		const discovery = f.discover();
		await entered.promise;
		const key = wifiAdapterLockKey(
			heldTwin === 0 ? "limited:3:0" : "limited:5:0",
		);
		const operation = withWifiAdapterLock(key, async () => {
			operationHeld = true;
			admitted.resolve();
			await finish.promise;
			operationHeld = false;
		});
		try {
			await admitted.promise;
			release.resolve();
			await discovery;
			expect(operationHeld).toBe(true);
			expect(key).toBe(heldTwin === 0 ? "limited:3:0" : `${MAC}@phy1`);
			expect(disconnected).toEqual(heldTwin === 0 ? [] : [uuid]);
			expect(profile["connection.autoconnect"]).toBe(
				heldTwin === 0 ? "yes" : "no",
			);
			expect(getBootReadiness().degradedSubsystems).toEqual([]);
		} finally {
			release.resolve();
			finish.resolve();
			await operation;
			await discovery;
		}
		await f.discover();
		expect(disconnected).toEqual([uuid]);
		expect(profile["connection.autoconnect"]).toBe("no");
	},
);
