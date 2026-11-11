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
	resetBondOptOutSession,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { setBondIdentityResolverForTest } from "../modules/streaming/bond-entry.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
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
