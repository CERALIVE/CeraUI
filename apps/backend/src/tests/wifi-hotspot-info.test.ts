import { describe, expect, test } from "bun:test";

import { HotspotInfoOutput } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import {
	type HotspotInfoDeps,
	parseGatewayIp,
	resolveHotspotInfo,
} from "../modules/wifi/wifi-hotspot-info.ts";
import type { WifiInterface } from "../modules/wifi/wifi-interfaces.ts";
import { hotspotInfoProcedure } from "../rpc/procedures/wifi.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// Build an active-hotspot interface: isHotspot() requires hotspot.conn truthy
// AND the active conn equal to it.
function makeActiveHotspotIface(opts: {
	ssid: string;
	conn?: string;
}): WifiInterface {
	const conn = opts.conn ?? "hotspot-uuid";
	return {
		id: 0,
		ifname: "wlan0",
		conn,
		hw: "Realtek RTL8812AU",
		available: new Map(),
		saved: {},
		hotspot: {
			conn,
			name: opts.ssid,
			availableChannels: ["auto"],
			warnings: {},
		},
	} as unknown as WifiInterface;
}

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

// ─── parseGatewayIp ──────────────────────────────────────────────────────────

describe("parseGatewayIp", () => {
	test("strips the CIDR prefix from an nmcli IPv4 address", () => {
		expect(parseGatewayIp("10.42.0.1/24")).toBe("10.42.0.1");
	});

	test("returns the address unchanged when there is no prefix", () => {
		expect(parseGatewayIp("10.42.0.1")).toBe("10.42.0.1");
	});

	test("defaults to the NM hotspot gateway when the value is empty/undefined", () => {
		expect(parseGatewayIp(undefined)).toBe("10.42.0.1");
		expect(parseGatewayIp("")).toBe("10.42.0.1");
	});
});

// ─── resolveHotspotInfo — happy path (active hotspot) ────────────────────────

describe("resolveHotspotInfo — active hotspot", () => {
	test("returns ssid + stripped gateway IP + isActive, with NO password key", async () => {
		const deps: HotspotInfoDeps = {
			interfaces: () => ({
				"dc:a6:32:00:00:01": makeActiveHotspotIface({ ssid: "CeraLive-AP" }),
			}),
			getConnIpv4Address: async () => "10.42.0.1/24",
		};

		const result = await resolveHotspotInfo(deps);

		expect(result).toEqual({
			ssid: "CeraLive-AP",
			gatewayIp: "10.42.0.1",
			isActive: true,
		});
		// G3: the surface must never carry a password.
		expect(result).not.toHaveProperty("password");
		// Output must validate against the public schema (which has no password).
		expect(HotspotInfoOutput.safeParse(result).success).toBe(true);
	});
});

// ─── resolveHotspotInfo — edge (no active hotspot) ───────────────────────────

describe("resolveHotspotInfo — no active hotspot", () => {
	test("returns isActive:false and an empty gatewayIp", async () => {
		const deps: HotspotInfoDeps = {
			interfaces: () => ({}),
			// Must not be consulted when nothing is active.
			getConnIpv4Address: async () => {
				throw new Error("should not query IP when no hotspot is active");
			},
		};

		const result = await resolveHotspotInfo(deps);

		expect(result).toEqual({ ssid: "", gatewayIp: "", isActive: false });
		expect(result).not.toHaveProperty("password");
	});
});

// ─── procedure wiring (authed) ───────────────────────────────────────────────

describe("wifi.hotspotInfo procedure", () => {
	test("is callable and returns a schema-valid, password-free payload", async () => {
		const result = await call(hotspotInfoProcedure, undefined, {
			context: makeContext(),
		});

		expect(HotspotInfoOutput.safeParse(result).success).toBe(true);
		expect(result).not.toHaveProperty("password");
		expect(typeof result.isActive).toBe("boolean");
	});
});
