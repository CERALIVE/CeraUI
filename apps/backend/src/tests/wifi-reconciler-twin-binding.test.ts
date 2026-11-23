import { expect, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import {
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

test.each(["path", "interface"] as const)(
	"r5 inactive twins resolve the %s-pinned owner for locking and station persistence",
	async (pin) => {
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
			const uuid = `${PROFILE}-${i}`;
			f.profiles.set(uuid, {
				"802-11-wireless.mode": "ap",
				"connection.autoconnect": "yes",
				"802-11-wireless.mac-address": MAC,
				"connection.interface-name": pin === "interface" ? row.ifname : "",
				"match.path": pin === "path" ? `usb-port${i}` : "",
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
				conn: uuid,
			});
			f.persistMode(owner, "hotspot");
		}
		await f.sample();
		expect(
			await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map()),
		).toBe(true);
		const owner = `${MAC}@phy0`;
		const release = Promise.withResolvers<void>();
		const held = withWifiAdapterLock(
			wifiAdapterLockKey(owner),
			() => release.promise,
		);
		try {
			expect(
				await setWifiAdapterMode(0, "station", {
					...defaultAdapterModeDeps,
					publishOutcome: () => undefined,
				}),
			).toEqual({ success: false, error: "DEVICE_BUSY" });
			expect(getConfig().wifi_modes?.[owner]).toBe("hotspot");
		} finally {
			release.resolve();
			await held;
		}
		expect(
			await setWifiAdapterMode(0, "station", {
				...defaultAdapterModeDeps,
				publishOutcome: () => undefined,
			}),
		).toEqual({ success: true, applied: "station" });
		expect(getConfig().wifi_modes).toEqual({
			[`${MAC}@phy0`]: "station",
			[`${MAC}@phy1`]: "hotspot",
		});
	},
);

test("r5 contradictory interface and path pins grant neither twin the owner", async () => {
	resetHotspotCredentialsForTest();
	const row = f.row();
	f.profiles.set(PROFILE, {
		"802-11-wireless.mode": "ap",
		"connection.autoconnect": "no",
		"connection.interface-name": "wlan0",
		"802-11-wireless.mac-address": MAC,
		"match.path": "other-port",
	});
	rememberHotspotCredentials(`${MAC}@phy0`, {
		ssid: "Twin",
		password: "fixture-password",
		conn: PROFILE,
	});
	removeWifiInterface(MAC);
	row.degradedReason = "permanent-mac-unresolved";
	delete row.hotspot.conn;
	addWifiInterface("limited:3:0", row);
	const other = { ...row, id: 1, ifname: "wlan1", hotspot: { ...row.hotspot } };
	addWifiInterface("limited:5:0", other);
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: "other-port",
	});
	await f.sample();
	await quiesceHotspotAutoconnect(wifiRadioIdentity.state.rows, new Map());
	expect(wifiAdapterLockKey("limited:3:0")).toBe("limited:3:0");
	expect(wifiAdapterLockKey("limited:5:0")).toBe("limited:5:0");
});
