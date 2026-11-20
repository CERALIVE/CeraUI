import { afterEach, expect, spyOn, test } from "bun:test";
import { getConfig, getConfigFilePath } from "../modules/config.ts";
import * as nm from "../modules/network/network-manager.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import {
	initHotspotCredentials,
	rememberHotspotCredentials,
	resetHotspotCredentialsForTest,
} from "../modules/wifi/hotspot-credentials.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import {
	defaultAdapterModeDeps,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { reconcileWifiAdapterLocked } from "../modules/wifi/wifi-adapter-reconciler.ts";
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
const owner0 = `${MAC}@phy0`;
const owner1 = `${MAC}@phy1`;
const limited0 = "limited:3:0";

async function twins(): Promise<void> {
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
		const owner = `${MAC}@phy${i}`;
		f.profiles.set(`${PROFILE}-${i}`, {
			"802-11-wireless.mode": "ap",
			"connection.autoconnect": "no",
			"connection.interface-name": row.ifname,
			"802-11-wireless.mac-address": MAC,
			"match.path": `usb-port${i}`,
		});
		f.witnesses.set(row.ifname, {
			ifindex: 3 + i * 2,
			phy: `/sys/devices/policy/phy${i}`,
			mac: MAC,
			path: `usb-port${i}`,
		});
		addWifiInterface(`limited:${3 + i * 2}:0`, row);
		getWifiIdToMacAddress()[i] = `limited:${3 + i * 2}:0`;
		rememberHotspotCredentials(owner, {
			ssid: `Twin ${i}`,
			password: "fixture-password",
			conn: `${PROFILE}-${i}`,
		});
		f.persistMode(owner, "hotspot");
	}
	await f.sample();
	await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map());
	expect(wifiAdapterLockKey(limited0)).toBe(owner0);
	expect(wifiAdapterLockKey("limited:5:0")).toBe(owner1);
}

function contradict(): void {
	const profile = f.profiles.get(`${PROFILE}-0`);
	if (!profile) throw new Error("Missing bound profile");
	profile["match.path"] = "usb-port1";
}

test.each([false, true])(
	"r6 an ambiguous station claimant preserves another claimant's live AP, reversed=%s",
	async (reversed) => {
		const claims = [owner0, owner1].map(
			(owner) =>
				[
					owner,
					{ ssid: "Policy AP", password: "fixture-password", conn: PROFILE },
				] as const,
		);
		const path = getConfigFilePath().replace("config.json", "collision.json");
		await Bun.write(
			path,
			JSON.stringify({
				version: 2,
				adapters: Object.fromEntries(reversed ? claims.reverse() : claims),
			}),
		);
		await initHotspotCredentials(path);
		f.persistMode(owner0, "station");
		f.persistMode(owner1, "hotspot");
		await f.sample();
		const disconnect = spyOn(nm, "nmDisconnect").mockResolvedValue(true);
		const active = new Map([["wlan0", PROFILE]]);
		expect(
			await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, active),
		).toBe(true);
		expect(disconnect).not.toHaveBeenCalled();
		expect(active.get("wlan0")).toBe(PROFILE);
		expect(getConfig().wifi_modes).toEqual({
			[owner0]: "station",
			[owner1]: "hotspot",
		});
	},
);

test("r6 positive pin contradiction revokes a remembered twin before durable station choice", async () => {
	await twins();
	contradict();
	await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map());
	expect(wifiAdapterLockKey(limited0)).toBe(limited0);
	expect(
		await setWifiAdapterMode(0, "station", {
			...defaultAdapterModeDeps,
			publishOutcome: () => undefined,
		}),
	).toEqual({ success: true, applied: "station" });
	expect(getConfig().wifi_modes).toEqual({
		[owner0]: "hotspot",
		[owner1]: "hotspot",
	});
});

test("r6 unreadable evidence retains remembered owner serialization", async () => {
	await twins();
	spyOn(nm, "nmConnGetFields").mockResolvedValue(undefined);
	expect(
		await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map()),
	).toBe(false);
	expect(wifiAdapterLockKey(limited0)).toBe(owner0);
});

test("r6 incomplete path evidence cannot revive a positively contradicted owner", async () => {
	await twins();
	contradict();
	await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map());
	const witness = f.witnesses.get("wlan0");
	const profile = f.profiles.get(`${PROFILE}-0`);
	if (!witness || !profile) throw new Error("Missing twin evidence");
	delete witness.path;
	await f.sample();
	await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map());
	expect(wifiAdapterLockKey(limited0)).toBe(limited0);
	witness.path = "usb-port0";
	profile["match.path"] = "usb-port0";
	await f.sample();
	await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map());
	expect(wifiAdapterLockKey(limited0)).toBe(owner0);
});

test("r6 contradiction revocation waits for an admitted owner's lock to release", async () => {
	await twins();
	const held = await withWifiAdapterLock(
		wifiAdapterLockKey(owner0),
		async () => {
			contradict();
			await reconcileWifiAdapterLocked(owner0, {
				identities: wifiRadioIdentity.state.rows,
				active: new Map(),
			});
			expect(wifiAdapterLockKey(limited0)).toBe(owner0);
		},
	);
	expect(held.success).toBe(true);
	expect(wifiAdapterLockKey(limited0)).toBe(limited0);
	expect(getConfig().wifi_modes?.[owner0]).toBe("hotspot");
});
