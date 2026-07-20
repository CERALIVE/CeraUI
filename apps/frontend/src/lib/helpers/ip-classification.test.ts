import { describe, expect, it } from "vitest";

import { isLinkLocalIpv4 } from "./ip-classification";

describe("isLinkLocalIpv4 — 169.254.0.0/16 display hint", () => {
	it("matches a real kernel-assigned link-local address", () => {
		// Given the exact address the user reported as "unclearable / hardcoded"
		// Then it is recognised as link-local
		expect(isLinkLocalIpv4("169.254.149.160")).toBe(true);
	});

	it("matches the boundaries of the /16 block", () => {
		expect(isLinkLocalIpv4("169.254.0.0")).toBe(true);
		expect(isLinkLocalIpv4("169.254.255.255")).toBe(true);
		expect(isLinkLocalIpv4("169.254.1.1")).toBe(true);
	});

	it("does NOT match a routable DHCP / static address", () => {
		// Given the real DHCP lease that coexists with the link-local address
		// Then it is NOT flagged (the UI must not label a real IP as fallback)
		expect(isLinkLocalIpv4("192.168.78.131")).toBe(false);
		expect(isLinkLocalIpv4("10.0.0.5")).toBe(false);
		expect(isLinkLocalIpv4("172.16.4.9")).toBe(false);
	});

	it("does NOT match neighbouring 169.x ranges outside 169.254/16", () => {
		expect(isLinkLocalIpv4("169.253.1.1")).toBe(false);
		expect(isLinkLocalIpv4("169.255.1.1")).toBe(false);
		expect(isLinkLocalIpv4("169.24.1.1")).toBe(false);
	});

	it("rejects malformed or out-of-range octets", () => {
		expect(isLinkLocalIpv4("169.254.999.1")).toBe(false);
		expect(isLinkLocalIpv4("169.254.1")).toBe(false);
		expect(isLinkLocalIpv4("169.254.1.1.1")).toBe(false);
		expect(isLinkLocalIpv4("169.254.a.b")).toBe(false);
	});

	it("tolerates absent / whitespace input without throwing", () => {
		expect(isLinkLocalIpv4(undefined)).toBe(false);
		expect(isLinkLocalIpv4(null)).toBe(false);
		expect(isLinkLocalIpv4("")).toBe(false);
		expect(isLinkLocalIpv4("  169.254.149.160  ")).toBe(true);
	});
});
