import { afterEach, describe, expect, test } from "bun:test";
import { netifMessageSchema } from "@ceraui/rpc/schemas";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import {
	getMockIfconfigOutput,
	getMockModemNetMarker,
} from "../mocks/providers/network.ts";
import {
	netIfBuildMsg,
	processIfconfigOutput,
	resetModemNetTracking,
} from "../modules/network/network-interfaces.ts";

const previousMockMode = process.env.MOCK_MODE;

afterEach(() => {
	stopMockService();
	processIfconfigOutput("");
	resetModemNetTracking();
	if (previousMockMode === undefined) delete process.env.MOCK_MODE;
	else process.env.MOCK_MODE = previousMockMode;
});

describe("multi-modem-wifi modem data interfaces", () => {
	test("does not mark absent scenario modems or guess from USB interface names", () => {
		process.env.MOCK_MODE = "true";
		initMockService("single-modem");
		expect(getMockModemNetMarker("usb0")?.kind).toBe("modem-net");
		for (const name of ["usb1", "usb2", "usb99", "eth0", "dg0h"]) {
			expect(getMockModemNetMarker(name)).toBeUndefined();
		}
	});

	test("retracts the mock marker once when the scenario no longer owns the interface", () => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
		processIfconfigOutput(getMockIfconfigOutput());
		expect(netIfBuildMsg().usb2?.usb_modem_net?.kind).toBe("modem-net");
		initMockService("single-modem");
		expect(netIfBuildMsg().usb2?.usb_modem_net).toBeNull();
		expect(netIfBuildMsg().usb2?.usb_modem_net).toBeUndefined();
	});

	test("is inert after the mock service stops", () => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
		stopMockService();
		expect(getMockModemNetMarker("usb0")).toBeUndefined();
	});

	test("publishes each modem's marker through the real netif wire projection", () => {
		// Given the scenario's own interface enumeration, not a hand-built wire map.
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
		processIfconfigOutput(getMockIfconfigOutput());

		// When the same projection used by the broadcast crosses its wire schema.
		const wire = netifMessageSchema.parse(netIfBuildMsg());

		// Then each USB data function is identifiable without changing its address or bond.
		for (const [name, model, ip] of [
			["usb0", "RM520N-GL", "10.0.0.2"],
			["usb1", "EM7455", "10.0.1.2"],
			["usb2", "RM500Q-GL", "10.0.2.2"],
		] as const) {
			expect(wire[name]).toMatchObject({
				ip,
				enabled: true,
				usb_modem_net: { kind: "modem-net", model },
			});
		}
		for (const name of ["eth0", "wlan0", "wlan1"]) {
			expect(wire[name]).toBeDefined();
			expect(wire[name]?.usb_modem_net).toBeUndefined();
		}
	});
});
