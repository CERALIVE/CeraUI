import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call } from "@orpc/server";

import { clearRecentLogLines, getRecentLogLines } from "../helpers/logger.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import {
	attachHuaweiTwins,
	HUAWEI_TWIN_IP,
	installHuaweiIdentityResolver,
	lastNetifEnabled,
	makeRpcContext,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";

describe("network.configure — board-reproduced Huawei include truth", () => {
	beforeEach(() => {
		resetBondFixture();
		installHuaweiIdentityResolver();
		attachHuaweiTwins();
		clearRecentLogLines();
	});

	afterEach(() => {
		resetBondFixture();
	});

	test("the applied reply and confirming netif frame report the same resulting state", async () => {
		// Given the exact board topology: two HiLink units with one factory MAC and
		// one leased address, whose duplicate-IP flag forces the raw bit false.
		const frames: string[] = [];

		// When the operator asks to include the eth-named twin.
		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: "eth1", ip: HUAWEI_TWIN_IP, enabled: true },
			{ context: makeRpcContext(frames) },
		);

		// Then the RPC must read back the bond verdict, never echo true over a
		// broadcast that still says false (the captured 2026-08-30 regression).
		expect(result).toEqual({
			success: true,
			applied: { name: "eth1", ip: HUAWEI_TWIN_IP, enabled: true },
		});
		expect(lastNetifEnabled(frames, "eth1")).toBe(true);
	});

	test("the mutation emits one structured incident-reconstruction line", async () => {
		await call(
			configureNetworkInterfaceProcedure,
			{ name: "eth1", ip: HUAWEI_TWIN_IP, enabled: false },
			{ context: makeRpcContext() },
		);
		await new Promise((resolve) => setTimeout(resolve, 20));

		const line = getRecentLogLines().find((candidate) =>
			candidate.includes("network bond mutation"),
		);
		expect(line).toBeDefined();
		expect(line).toContain('"iface":"eth1"');
		expect(line).toContain('"physical_id":');
		expect(line).toContain('"requested":false');
		expect(line).toContain('"resulted":false');
		expect(line).toContain('"reason":"applied"');
	});
});
