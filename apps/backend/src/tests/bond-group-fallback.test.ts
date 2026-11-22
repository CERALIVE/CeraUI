import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { call } from "@orpc/server";

import { getConfig, loadConfig, setConfigFilePath } from "../modules/config.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	isBondOptedOut,
	setPersistentBondOptOut,
} from "../modules/network/bond-preference.ts";
import {
	netIfBuildMsg,
	onNetworkInterfacesChange,
	processIfconfigOutput,
	resetBondOptOutSession,
} from "../modules/network/network-interfaces.ts";
import {
	defaultRouterCellularScanDeps,
	getUsbPhysicalDescriptor,
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import { firstSightIfconfig } from "./helpers/bond-first-sight-fixture.ts";
import {
	clearBondNetworkFixture,
	HUAWEI_TWIN_IP,
	makeRpcContext,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

const sharedSerial = "syntheticTwinV9";
const lateCollisionTwins = constructedTwins.map((device) => ({
	...device,
	serial: sharedSerial,
}));
const legacyExclusion = mintLinkId(`usb-serial:413c:${sharedSerial}`);
const lateA = "wwu1u4c2";
const lateB = "wwu1c2";
const onlyLateA = lateCollisionTwins.filter(
	(device) => device.ifname === lateA,
);

async function scanLateCollisionDevices(
	devices: typeof lateCollisionTwins,
): Promise<void> {
	await refreshUsbNetMarkers(
		devices.map((device) => device.ifname),
		{
			...constructedTwinDeps(devices),
			sharedSerials: defaultRouterCellularScanDeps.sharedSerials,
		},
	);
}

describe("bond preference group fallback for unseen twins", () => {
	let configPath = "";

	beforeEach(async () => {
		resetBondFixture();
		resetUsbNetMarkers();
		configPath = join(
			mkdtempSync(join(tmpdir(), "bond-group-fallback-")),
			"config.json",
		);
		writeFileSync(configPath, "{}");
		setConfigFilePath(configPath);
		await loadConfig();
	});

	afterEach(() => {
		resetBondFixture();
		resetUsbNetMarkers();
		setConfigFilePath("config.json");
		rmSync(dirname(configPath), { recursive: true, force: true });
	});

	async function loadLegacySingleton(): Promise<void> {
		writeFileSync(
			configPath,
			JSON.stringify({ bond_opt_out: { [legacyExclusion]: true } }),
		);
		await loadConfig();
		await scanLateCollisionDevices(onlyLateA);
	}

	async function reloadWithoutDevices(): Promise<void> {
		resetBondOptOutSession();
		clearBondNetworkFixture();
		resetUsbNetMarkers();
		await loadConfig();
	}

	test("keeps a twin out when the shared serial is first recognized after its sibling is enabled", async () => {
		const a = lateA;
		const b = lateB;
		const aIfconfig = firstSightIfconfig(a, HUAWEI_TWIN_IP);
		await loadLegacySingleton();
		expect(getUsbPhysicalDescriptor(b)).toBeUndefined();
		expect(resolveModemPhysicalIdentity(a).linkId).toBe(legacyExclusion);
		expect(resolveModemPhysicalIdentity(a).legacyLinkId).toBeUndefined();
		processIfconfigOutput(aIfconfig);
		expect(netIfBuildMsg()[a]?.enabled).toBe(false);

		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: a, ip: HUAWEI_TWIN_IP, enabled: true },
			{ context: makeRpcContext() },
		);
		expect(result.success).toBe(true);
		expect(netIfBuildMsg()[a]?.enabled).toBe(true);
		await reloadWithoutDevices();

		let first: ReturnType<typeof netIfBuildMsg> | undefined;
		const unsubscribe = onNetworkInterfacesChange(() => {
			const snapshot = netIfBuildMsg();
			if (snapshot[b] !== undefined) first ??= snapshot;
		});
		try {
			await scanLateCollisionDevices(lateCollisionTwins);
			expect(resolveModemPhysicalIdentity(a).legacyLinkId).toBe(
				legacyExclusion,
			);
			expect(resolveModemPhysicalIdentity(b).legacyLinkId).toBe(
				legacyExclusion,
			);
			processIfconfigOutput(
				`${aIfconfig}\n\n${firstSightIfconfig(b, HUAWEI_TWIN_IP)}`,
			);
			expect(first?.[a]?.enabled).toBe(true);
			expect(first?.[b]?.enabled).toBe(false);
		} finally {
			unsubscribe();
		}
	});

	test("retains the fallback through an empty scan and a reload with neither twin present", async () => {
		await loadLegacySingleton();
		setPersistentBondOptOut(lateA, false);

		await scanLateCollisionDevices([]);
		await reloadWithoutDevices();
		await scanLateCollisionDevices([]);
		expect(getUsbPhysicalDescriptor(lateA)).toBeUndefined();
		expect(getUsbPhysicalDescriptor(lateB)).toBeUndefined();

		await scanLateCollisionDevices(onlyLateA);
		expect(resolveModemPhysicalIdentity(lateA).anchor).toBe("usb-serial");
		expect(isBondOptedOut(lateA)).toBe(false);
		await scanLateCollisionDevices(lateCollisionTwins);
		expect(isBondOptedOut(lateA)).toBe(false);
		expect(isBondOptedOut(lateB)).toBe(true);
	});

	test("a third port still inherits the exclusion after both known twins are enabled", async () => {
		await loadLegacySingleton();
		setPersistentBondOptOut(lateA, false);
		await scanLateCollisionDevices(lateCollisionTwins);
		setPersistentBondOptOut(lateB, false);
		await reloadWithoutDevices();

		const c = "wwu3c2";
		const third = onlyLateA.map((device) => ({
			...device,
			ifname: c,
			readlink: "/sys/devices/platform/fc800000.usb/usb3/3-2/3-2:1.0",
			devpath: "2",
			udevadm: {
				...device.udevadm,
				ID_PATH: "platform-fc800000.usb-usb-0:2:1.0",
			},
		}));
		await scanLateCollisionDevices([...lateCollisionTwins, ...third]);
		expect(resolveModemPhysicalIdentity(c).legacyLinkId).toBe(legacyExclusion);
		expect(isBondOptedOut(lateA)).toBe(false);
		expect(isBondOptedOut(lateB)).toBe(false);
		expect(isBondOptedOut(c)).toBe(true);
	});

	test("repeated singleton toggles replace one exception and survive two reloads", async () => {
		await loadLegacySingleton();
		for (const optOut of [false, false, true, true, false, false]) {
			setPersistentBondOptOut(lateA, optOut);
			expect(isBondOptedOut(lateA)).toBe(optOut);
		}
		await reloadWithoutDevices();
		await scanLateCollisionDevices(lateCollisionTwins);
		const aPort = resolveModemPhysicalIdentity(lateA).linkId;
		expect(isBondOptedOut(lateA)).toBe(false);
		expect(isBondOptedOut(lateB)).toBe(true);

		await reloadWithoutDevices();
		await scanLateCollisionDevices(onlyLateA);
		expect(resolveModemPhysicalIdentity(lateA).anchor).toBe("id-path");
		expect(isBondOptedOut(lateA)).toBe(false);
		expect(getConfig().bond_opt_out).toBeUndefined();
		expect(getConfig().bond_legacy_opt_out).toEqual({
			[legacyExclusion]: { [aPort]: true },
		});
	});
});
