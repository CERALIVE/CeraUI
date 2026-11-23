import { expect, test } from "bun:test";
import { z } from "zod";
import { getConfig, getConfigFilePath } from "../modules/config.ts";
import {
	getHotspotCredentialOwners,
	getHotspotCredentials,
	initHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import {
	prepareHotspotForInterface,
	startHotspotForInterface,
} from "../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import * as released from "./helpers/released/hotspot-credentials-v2026.11.2.ts";
import {
	autoconnectFixture,
	MAC,
	PORT,
	PROFILE,
} from "./helpers/wifi-autoconnect-fixture.ts";

const f = autoconnectFixture();
const ports = [PORT, "usb-PortTwo:2.0"] as const;
const saved = z.object({
	version: z.literal(2),
	adapters: z.record(
		z.string(),
		z.object({
			conn: z.string().optional(),
			previousConns: z.array(z.string()).optional(),
			pendingCreation: z.string().optional(),
		}),
	),
});

test("actual twin Start dispatch pins and persists each newly created profile under only its port across released rollback", async () => {
	const path = `${getConfigFilePath()}.credentials`;
	const plain = {
		ssid: "Legacy AP",
		password: "legacy-ap-password",
		conn: PROFILE,
	};
	await initHotspotCredentials(path);
	rememberHotspotCredentials(MAC, plain);
	const legacy = f.profiles.get(PROFILE);
	if (!legacy) throw new Error("Missing legacy profile");
	legacy["802-11-wireless.ssid"] = plain.ssid;
	legacy["802-11-wireless-security.psk"] = plain.password;
	f.witnesses.set("wlan1", {
		ifindex: 5,
		phy: "/sys/devices/policy/phy1",
		mac: MAC,
		path: ports[1],
	});
	f.list(["wlan0:wifi:disconnected:", "wlan1:wifi:disconnected:"]);
	await f.discover();
	const activated: string[] = [];
	const deps = {
		...f.deps,
		nmApConnAdd: async (
			...[ifname, identity, fields]: Parameters<typeof f.deps.nmApConnAdd>
		) => {
			const uuid = `activated-${ifname}-${activated.length}`;
			f.profiles.set(uuid, {
				...fields,
				"802-11-wireless.mode": "ap",
				"802-11-wireless.ssid": identity.name,
				"802-11-wireless-security.psk": identity.password,
			});
			return uuid;
		},
		nmConnect: async (uuid: string) => {
			activated.push(uuid);
			return f.profiles.has(uuid);
		},
	};
	async function start(index: number, serial: number) {
		const port = ports[index];
		const key = `${MAC}@${port}`;
		const row = getWifiInterfacesByMacAddress()[key];
		if (!row || !canHotspot(row)) throw new Error(`Missing twin at ${port}`);
		expect(await startHotspotForInterface(key, row, deps)).toEqual({
			success: true,
		});
		settlePending(row.ifname, true);
		const uuid = `activated-wlan${index}-${serial}`;
		expect(activated.at(-1)).toBe(uuid);
		expect(f.profiles.get(uuid)).toMatchObject({
			"802-11-wireless.mac-address": MAC,
			"match.path": port,
			"connection.autoconnect": "no",
			"802-11-wireless.ssid": "CERALIVE_791c",
		});
		expect(getHotspotCredentials(key)?.conn).toBe(uuid);
		expect(getHotspotCredentialOwners(uuid)).toEqual([key]);
		expect(getConfig().wifi_modes?.[key]).toBe("hotspot");
		return row;
	}
	await start(0, 0);
	const second = await start(1, 1);
	// Recreate a port's missing profile while retaining the saved credential and retired UUID.
	f.profiles.delete("activated-wlan1-1");
	second.hotspot = { availableChannels: ["auto"], warnings: {} };
	second.conn = null;
	second.activeConn = null;
	await start(1, 2);
	expect(getHotspotCredentials(MAC)).toMatchObject(plain);
	expect(getHotspotCredentials(`${MAC}@${ports[1]}`)?.previousConns).toEqual([
		"activated-wlan1-1",
	]);
	const checkUnique = async () => {
		const { adapters } = saved.parse(await Bun.file(path).json());
		const uuids = Object.values(adapters).flatMap(
			({ conn, previousConns, pendingCreation }) => [
				...(conn ? [conn] : []),
				...(previousConns ?? []),
				...(pendingCreation && pendingCreation !== conn
					? [pendingCreation]
					: []),
			],
		);
		expect(uuids.sort()).toEqual(
			[
				PROFILE,
				"activated-wlan0-0",
				"activated-wlan1-1",
				"activated-wlan1-2",
			].sort(),
		);
	};
	await checkUnique();
	try {
		await released.initHotspotCredentials(path);
		expect(released.getHotspotCredentials(MAC)).toMatchObject(plain);
		expect(released.canUseHotspotConnection(MAC, PROFILE)).toBe(true);
		released.rememberHotspotCredentials(MAC, { ...plain, channel: "auto" });
		await initHotspotCredentials(path);
		await checkUnique();
	} finally {
		released.resetHotspotCredentialsForTest();
	}
	f.witnesses.delete("wlan1");
	f.list(["wlan0:wifi:disconnected:"]);
	await f.discover();
	const sole = getWifiInterfacesByMacAddress()[MAC];
	if (!sole || !canHotspot(sole))
		throw new Error("Missing returning sole radio");
	const portProfile = { ...f.profiles.get("activated-wlan0-0") };
	const prepared = await prepareHotspotForInterface(MAC, sole, {}, deps);
	expect(await startHotspotForInterface(MAC, sole, deps)).toEqual({
		success: true,
	});
	settlePending(sole.ifname, true);
	expect(activated).toEqual([
		"activated-wlan0-0",
		"activated-wlan1-1",
		"activated-wlan1-2",
		PROFILE,
	]);
	expect(prepared).toEqual({
		success: true,
		name: plain.ssid,
		password: plain.password,
	});
	expect(f.profiles.get("activated-wlan0-0")).toEqual(portProfile);
	expect(getHotspotCredentialOwners("activated-wlan0-0")).toEqual([
		`${MAC}@${ports[0]}`,
	]);
	expect(getHotspotCredentialOwners("activated-wlan1-2")).toEqual([
		`${MAC}@${ports[1]}`,
	]);
});
