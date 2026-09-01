import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "@orpc/server";

import { loadConfig, setConfigFilePath } from "../modules/config.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	netIfBuildMsg,
	resetBondOptOutSession,
} from "../modules/network/network-interfaces.ts";
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
		setConfigFilePath("config.json");
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
