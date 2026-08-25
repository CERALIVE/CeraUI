import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	getUplinkSteeringStatus,
	publishUplinkSteeringAvailability,
	resetUplinkSteeringStatusForTest,
} from "../modules/network/uplink-steering/status.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

afterEach(resetUplinkSteeringStatusForTest);

describe("uplink steering wire state", () => {
	test("publishes a typed steering_unavailable state and hydrates it post-login", () => {
		publishUplinkSteeringAvailability({
			available: false,
			reason: "policy_route_missing",
			detail: "wlan0: source rule is missing",
		});

		expect(getUplinkSteeringStatus()).toEqual({
			state: "steering_unavailable",
			reason: "policy_route_missing",
			detail: "wlan0: source rule is missing",
		});
		const initial = buildInitialStatus();
		expect(initial.uplinkSteering).toEqual(getUplinkSteeringStatus());
		expect("uplinkFlowsReset" in initial).toBe(false);
	});

	test("the production adapter hydrates persistent state but not the transient reset", () => {
		const source = readFileSync(
			fileURLToPath(new URL("../rpc/adapter.ts", import.meta.url)),
			"utf8",
		);
		expect(source).toContain(
			'sendToClient(ws, "uplink-steering", initialStatus.uplinkSteering)',
		);
		expect(source).not.toContain(
			'sendToClient(ws, "uplink-flows-reset", initialStatus',
		);
	});

	test("main guards initialization and runtime reuses existing event sources", () => {
		const main = readFileSync(
			fileURLToPath(new URL("../main.ts", import.meta.url)),
			"utf8",
		);
		const runtime = readFileSync(
			fileURLToPath(
				new URL(
					"../modules/network/uplink-steering/runtime.ts",
					import.meta.url,
				),
			),
			"utf8",
		);
		expect(main).toContain(
			'await guardNonCritical("uplink-steering", initUplinkSteering)',
		);
		expect(runtime).toContain("onNetworkInterfacesChange(reconcile)");
		expect(runtime).toContain("onUplinkHealthChange(reconcile)");
		expect(runtime).not.toContain("createMonitorManager");
	});
});
