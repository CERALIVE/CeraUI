import { describe, expect, it } from "bun:test";
import { isLocalIp } from "../helpers/ip-addresses.ts"; // Adjust the import path if necessary

describe("isLocalIp", () => {
	it("should return true for loopback addresses", () => {
		expect(isLocalIp("127.0.0.1")).toBe(true);
		expect(isLocalIp("127.255.255.255")).toBe(true);
	});

	it("should return true for private class A addresses", () => {
		expect(isLocalIp("10.0.0.1")).toBe(true);
		expect(isLocalIp("10.255.255.255")).toBe(true);
	});

	it("should return true for private class B addresses", () => {
		expect(isLocalIp("172.16.0.1")).toBe(true);
		expect(isLocalIp("172.31.255.255")).toBe(true);
		expect(isLocalIp("172.15.255.255")).toBe(false); // Outside the private range
		expect(isLocalIp("172.32.0.0")).toBe(false); // Outside the private range
	});

	it("should return true for private class C addresses", () => {
		expect(isLocalIp("192.168.1.1")).toBe(true);
		expect(isLocalIp("192.168.255.255")).toBe(true);
	});

	it("should return true for link-local addresses", () => {
		expect(isLocalIp("169.254.1.1")).toBe(true);
	});

	it("should return false for public addresses", () => {
		expect(isLocalIp("8.8.8.8")).toBe(false);
		expect(isLocalIp("1.1.1.1")).toBe(false);
		expect(isLocalIp("192.169.1.1")).toBe(false); // Similar but not private
		expect(isLocalIp("172.33.0.1")).toBe(false); // Outside the private range
	});

	it("should return false for invalid IPs", () => {
		expect(isLocalIp("999.999.999.999")).toBe(false);
		expect(isLocalIp("not.an.ip")).toBe(false);
		expect(isLocalIp("")).toBe(false);
	});
});
