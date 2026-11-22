import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";

import {
	getConfig,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { mintLinkId } from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	isBondOptedOut,
	setPersistentBondOptOut,
} from "../modules/network/bond-preference.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
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
import { setBondIdentityResolverForTest } from "../modules/streaming/bond-entry.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import { firstSightIfconfig } from "./helpers/bond-first-sight-fixture.ts";
import {
	attachHuaweiTwins,
	clearBondNetworkFixture,
	HUAWEI_PORT_IDENTITIES,
	HUAWEI_TWIN_IP,
	installHuaweiIdentityResolver,
	makeRpcContext,
	physicalRecord,
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

describe("operator bond opt-out — config.json restart persistence", () => {
	let configPath = "";

	beforeEach(async () => {
		resetBondFixture();
		configPath = join(
			mkdtempSync(join(tmpdir(), "bond-opt-out-")),
			"config.json",
		);
		writeFileSync(configPath, "{}");
		setConfigFilePath(configPath);
		await loadConfig();
		installHuaweiIdentityResolver();
		attachHuaweiTwins();
	});

	afterEach(() => {
		resetBondFixture();
		resetUsbNetMarkers();
		setConfigFilePath("config.json");
	});

	async function loadLegacySingleton(): Promise<void> {
		clearBondNetworkFixture();
		setBondIdentityResolverForTest(null);
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

	test("migrates a legacy opt-out to both twins before admitting one", async () => {
		clearBondNetworkFixture();
		setBondIdentityResolverForTest(null);
		await refreshUsbNetMarkers(
			constructedTwins.map((d) => d.ifname),
			constructedTwinDeps(),
		);
		attachHuaweiTwins("wwu1u4c2", "wwu1c2");
		const legacy = mintLinkId("usb-serial:413c:0123456789ABCDEF");
		getConfig().bond_opt_out = { [legacy]: true };
		saveConfig();
		expect(isBondOptedOut("wwu1u4c2")).toBe(true);
		expect(isBondOptedOut("wwu1c2")).toBe(true);
		// The USB scan can know a twin before the netif projection publishes it.
		delete getNetworkInterfaces().wwu1c2;
		setPersistentBondOptOut("wwu1u4c2", false);
		expect(isBondOptedOut("wwu1u4c2")).toBe(false);
		expect(isBondOptedOut("wwu1c2")).toBe(true);
		expect(getConfig().bond_opt_out?.[legacy]).toBeUndefined();
		const twinId = resolveModemPhysicalIdentity("wwu1c2").linkId;
		resetBondOptOutSession();
		await loadConfig();
		expect(getConfig().bond_opt_out?.[twinId]).toBe(true);
		expect(isBondOptedOut("wwu1c2")).toBe(true);
	});

	test("keeps an unplugged twin out of the first bond snapshot after its sibling is enabled", async () => {
		const a = "wwu1u4c2";
		const b = "wwu1c2";
		const aIfconfig = firstSightIfconfig(a, HUAWEI_TWIN_IP);
		clearBondNetworkFixture();
		setBondIdentityResolverForTest(null);
		await refreshUsbNetMarkers(
			[a],
			constructedTwinDeps(constructedTwins.filter((d) => d.ifname === a)),
		);
		expect(getUsbPhysicalDescriptor(b)).toBeUndefined();
		processIfconfigOutput(aIfconfig);
		getConfig().bond_opt_out = {
			[mintLinkId("usb-serial:413c:0123456789ABCDEF")]: true,
		};
		saveConfig();
		expect(netIfBuildMsg()[a]?.enabled).toBe(false);

		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: a, ip: HUAWEI_TWIN_IP, enabled: true },
			{ context: makeRpcContext() },
		);
		expect(result.success).toBe(true);
		expect(netIfBuildMsg()[a]?.enabled).toBe(true);
		resetBondOptOutSession();
		clearBondNetworkFixture();
		resetUsbNetMarkers();
		await loadConfig();

		let first: ReturnType<typeof netIfBuildMsg> | undefined;
		const unsubscribe = onNetworkInterfacesChange(() => {
			const snapshot = netIfBuildMsg();
			if (snapshot[b] !== undefined) first ??= snapshot;
		});
		try {
			await refreshUsbNetMarkers([a, b], constructedTwinDeps());
			processIfconfigOutput(
				`${aIfconfig}\n\n${firstSightIfconfig(b, HUAWEI_TWIN_IP)}`,
			);
			expect(first?.[a]?.enabled).toBe(true);
			expect(first?.[b]?.enabled).toBe(false);
		} finally {
			unsubscribe();
		}

		setPersistentBondOptOut(b, false);
		expect(netIfBuildMsg()[b]?.enabled).toBe(true);
		setPersistentBondOptOut(b, true);
		expect(netIfBuildMsg()[a]?.enabled).toBe(true);
		expect(netIfBuildMsg()[b]?.enabled).toBe(false);
	});

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

	test("an opt-out survives a simulated backend restart and follows the physical port", async () => {
		// Given the operator excludes the first Huawei while it is called eth1.
		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: "eth1", ip: HUAWEI_TWIN_IP, enabled: false },
			{ context: makeRpcContext() },
		);
		expect(result.success).toBe(true);
		const persisted = readFileSync(configPath, "utf8");
		expect(persisted).toContain(
			physicalRecord("eth1", HUAWEI_PORT_IDENTITIES.eth1).linkId,
		);
		expect(persisted).not.toContain('"eth1":true');

		// When process memory is replaced from config.json and the same physical
		// port re-enumerates under a different interface name.
		resetBondOptOutSession();
		await loadConfig();
		clearBondNetworkFixture();
		installHuaweiIdentityResolver({
			usbHuaweiA: HUAWEI_PORT_IDENTITIES.eth1,
			usbHuaweiB: HUAWEI_PORT_IDENTITIES.enx0c5b8f279a64,
		});
		attachHuaweiTwins("usbHuaweiA", "usbHuaweiB");
		const wire = netIfBuildMsg();
		const current = wire.usbHuaweiA;

		// Then the durable physical identity, not the retired ifname, keeps it out.
		expect(current?.enabled).toBe(false);
		const raw = getNetworkInterfaces();
		expect(raw.usbHuaweiA).toBeDefined();
		expect(
			raw.usbHuaweiA === undefined
				? true
				: isBondCandidate("usbHuaweiA", raw.usbHuaweiA),
		).toBe(false);
	});
});
