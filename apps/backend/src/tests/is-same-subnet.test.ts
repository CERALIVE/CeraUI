import { describe, expect, it } from "bun:test";

import { isSameSubnet } from "../helpers/ip-addresses";

describe("isSameSubnet", () => {
	it("should return true for IPs in the same /24 subnet", () => {
		expect(isSameSubnet("192.168.1.1", "192.168.1.2", "255.255.255.0")).toBe(true);
		expect(isSameSubnet("192.168.1.100", "192.168.1.200", "255.255.255.0")).toBe(true);
	});

	it("should return false for IPs in different /24 subnets", () => {
		expect(isSameSubnet("192.168.1.1", "192.168.2.1", "255.255.255.0")).toBe(false);
		expect(isSameSubnet("10.0.0.1", "10.0.1.1", "255.255.255.0")).toBe(false);
	});

	it("should return true for IPs in the same /16 subnet", () => {
		expect(isSameSubnet("192.168.1.1", "192.168.2.1", "255.255.0.0")).toBe(true);
		expect(isSameSubnet("10.0.1.1", "10.0.254.254", "255.255.0.0")).toBe(true);
	});

	it("should return false for IPs in different /16 subnets", () => {
		expect(isSameSubnet("10.1.1.1", "10.2.1.1", "255.255.0.0")).toBe(false);
	});

	it("should return true for IPs in the same /8 subnet", () => {
		expect(isSameSubnet("10.1.1.1", "10.2.2.2", "255.0.0.0")).toBe(true);
		expect(isSameSubnet("10.255.255.255", "10.0.0.0", "255.0.0.0")).toBe(true);
	});

	it("should return false for completely different networks", () => {
		expect(isSameSubnet("192.168.1.1", "10.0.0.1", "255.255.255.0")).toBe(false);
		expect(isSameSubnet("172.16.1.1", "8.8.8.8", "255.255.0.0")).toBe(false);
	});

	it("should handle edge cases", () => {
		expect(isSameSubnet("0.0.0.0", "0.0.0.0", "255.255.255.255")).toBe(true);
		expect(isSameSubnet("255.255.255.255", "255.255.255.255", "255.255.255.255")).toBe(true);
		expect(isSameSubnet("192.168.1.1", "192.168.1.2", "0.0.0.0")).toBe(true); // Any IP is in the same subnet with netmask 0.0.0.0
	});
});
