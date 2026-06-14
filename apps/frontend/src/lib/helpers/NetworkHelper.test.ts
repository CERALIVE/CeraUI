import { describe, expect, it } from "vitest";
import { generateDeviceAccessQr } from "./NetworkHelper";

describe("NetworkHelper", () => {
	describe("generateDeviceAccessQr", () => {
		it("should generate a data URL QR code for a valid device URL", async () => {
			const result = await generateDeviceAccessQr("http://10.42.0.1/");
			expect(result).toMatch(/^data:image\/png;base64,/);
		});

		it("should throw on empty string input", async () => {
			await expect(generateDeviceAccessQr("")).rejects.toThrow();
		});
	});
});
