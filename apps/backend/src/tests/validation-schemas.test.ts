import { describe, expect, it } from "bun:test";

import {
	BITRATE_MAX,
	BITRATE_MIN,
	bitrateInputSchema,
	hotspotConfigInputSchema,
	modemConfigInputSchema,
	netifConfigInputSchema,
	wifiNewInputSchema,
} from "@ceraui/rpc/schemas";

const validHotspot = {
	device: "wlan0",
	name: "MyHotspot",
	password: "supersecret",
	channel: "auto",
};

const validModem = {
	device: "0",
	network_type: "4g",
	apn: "internet",
	username: "",
	password: "",
};

describe("hotspotConfigInputSchema", () => {
	it("accepts a valid hotspot config", () => {
		expect(hotspotConfigInputSchema.safeParse(validHotspot).success).toBe(true);
	});

	it("rejects an empty name", () => {
		expect(
			hotspotConfigInputSchema.safeParse({ ...validHotspot, name: "" }).success,
		).toBe(false);
	});

	it("rejects a name longer than 32 characters", () => {
		expect(
			hotspotConfigInputSchema.safeParse({
				...validHotspot,
				name: "x".repeat(33),
			}).success,
		).toBe(false);
	});

	it("rejects a password shorter than 8 characters", () => {
		expect(
			hotspotConfigInputSchema.safeParse({ ...validHotspot, password: "123" })
				.success,
		).toBe(false);
	});

	it("rejects a password longer than 63 characters", () => {
		expect(
			hotspotConfigInputSchema.safeParse({
				...validHotspot,
				password: "x".repeat(64),
			}).success,
		).toBe(false);
	});

	it("rejects an out-of-range channel", () => {
		expect(
			hotspotConfigInputSchema.safeParse({ ...validHotspot, channel: "999" })
				.success,
		).toBe(false);
	});

	it("accepts a base64 password (no charset restriction)", () => {
		expect(
			hotspotConfigInputSchema.safeParse({
				...validHotspot,
				password: "abc+/=1234",
			}).success,
		).toBe(true);
	});

	it("accepts a unicode SSID and unicode password (no charset restriction)", () => {
		expect(
			hotspotConfigInputSchema.safeParse({
				...validHotspot,
				name: "My WiFi 📶",
				password: "пароль🔒1234",
			}).success,
		).toBe(true);
	});
});

describe("modemConfigInputSchema APN conditional", () => {
	it("rejects autoconfig=false with empty APN", () => {
		expect(
			modemConfigInputSchema.safeParse({
				...validModem,
				autoconfig: false,
				apn: "",
			}).success,
		).toBe(false);
	});

	it("accepts autoconfig=false with a valid APN", () => {
		expect(
			modemConfigInputSchema.safeParse({
				...validModem,
				autoconfig: false,
				apn: "internet",
			}).success,
		).toBe(true);
	});

	it("accepts autoconfig=true with empty APN", () => {
		expect(
			modemConfigInputSchema.safeParse({
				...validModem,
				autoconfig: true,
				apn: "",
			}).success,
		).toBe(true);
	});
});

describe("netifConfigInputSchema IP validation", () => {
	it("rejects an invalid IP address", () => {
		expect(
			netifConfigInputSchema.safeParse({
				name: "eth0",
				enabled: true,
				ip: "not-an-ip",
			}).success,
		).toBe(false);
	});

	it("accepts a valid IPv4 address", () => {
		expect(
			netifConfigInputSchema.safeParse({
				name: "eth0",
				enabled: true,
				ip: "192.168.1.10",
			}).success,
		).toBe(true);
	});

	it("accepts a valid IPv6 address", () => {
		expect(
			netifConfigInputSchema.safeParse({
				name: "eth0",
				enabled: true,
				ip: "fe80::1",
			}).success,
		).toBe(true);
	});

	it("accepts an omitted IP (DHCP)", () => {
		expect(
			netifConfigInputSchema.safeParse({ name: "eth0", enabled: true }).success,
		).toBe(true);
	});
});

describe("wifiNewInputSchema", () => {
	it("rejects an empty SSID", () => {
		expect(
			wifiNewInputSchema.safeParse({
				device: "wlan0",
				ssid: "",
				password: "supersecret",
			}).success,
		).toBe(false);
	});

	it("rejects a password shorter than 8 characters", () => {
		expect(
			wifiNewInputSchema.safeParse({
				device: "wlan0",
				ssid: "MyNetwork",
				password: "short",
			}).success,
		).toBe(false);
	});

	it("accepts a valid WPA connection", () => {
		expect(
			wifiNewInputSchema.safeParse({
				device: "wlan0",
				ssid: "MyNetwork",
				password: "supersecret",
			}).success,
		).toBe(true);
	});
});

describe("bitrateInputSchema canonical range", () => {
	it("exposes the canonical hardware range constants", () => {
		expect(BITRATE_MIN).toBe(500);
		expect(BITRATE_MAX).toBe(50000);
	});

	it("rejects a bitrate below BITRATE_MIN", () => {
		expect(
			bitrateInputSchema.safeParse({ max_br: BITRATE_MIN - 1 }).success,
		).toBe(false);
	});

	it("rejects a bitrate above BITRATE_MAX", () => {
		expect(
			bitrateInputSchema.safeParse({ max_br: BITRATE_MAX + 1 }).success,
		).toBe(false);
	});

	it("accepts a bitrate within range", () => {
		expect(bitrateInputSchema.safeParse({ max_br: 6000 }).success).toBe(true);
	});
});
