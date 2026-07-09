import { describe, expect, it } from "bun:test";

import { isParseError } from "../system/cli-parse.ts";
import { parseWifiDeviceProperties } from "./wifi-interfaces.ts";

describe("parseWifiDeviceProperties() — named fail-loud nmcli device parser", () => {
	it("parses product brackets and WiFi capability flags", () => {
		const result = parseWifiDeviceProperties([
			"Realtek Corporation",
			"802.11ac NIC [RTL8812AU]",
			"yes",
			"yes",
			"no",
		]);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				hw: "Realtek RTL8812AU",
				supportsAp: true,
				supports5Ghz: true,
				supports2Ghz: false,
			});
		}
	});

	it("keeps an unbracketed product name when nmcli provides one", () => {
		const result = parseWifiDeviceProperties([
			"MediaTek Inc.",
			"MT7921 Wi-Fi 6",
			"no",
			"no",
			"yes",
		]);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.hw).toBe("MediaTek Inc. MT7921 Wi-Fi 6");
			expect(result.value.supportsAp).toBe(false);
			expect(result.value.supports2Ghz).toBe(true);
		}
	});

	it("fails loud when the property tuple is incomplete", () => {
		const result = parseWifiDeviceProperties(["Realtek", "RTL8812AU"]);
		expect(isParseError(result)).toBe(true);
		if (!result.ok) expect(result.reason).toContain("5 fields");
	});

	it("fails loud when a yes/no capability field drifts", () => {
		const result = parseWifiDeviceProperties([
			"Realtek",
			"RTL8812AU",
			"maybe",
			"yes",
			"no",
		]);
		expect(isParseError(result)).toBe(true);
		if (!result.ok) expect(result.reason).toContain("yes/no");
	});
});
