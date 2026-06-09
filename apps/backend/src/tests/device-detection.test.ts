/*
 * Task 4 — real-device detection (gating prerequisite for the kiosk RPC, T13).
 *
 * Covers the five branches of the fail-safe classifier in
 * modules/system/device-detection.ts. The detection surface is injected through
 * `DeviceDetectionDeps` (mirrors the `KioskDeps` pattern in kiosk.ts) so no test
 * reads a host file or depends on real hardware. The default contract is
 * verified separately: an unrecognised host must resolve false.
 */
import { describe, expect, test } from "bun:test";
import {
	type DeviceDetectionDeps,
	isRealDevice,
} from "../modules/system/device-detection.ts";

function makeDeps(
	overrides: Partial<DeviceDetectionDeps> = {},
): DeviceDetectionDeps {
	return {
		getDeviceTypeOverride: () => undefined,
		isDevelopment: () => false,
		readDeviceTreeModel: async () => {
			throw new Error("ENOENT: /proc/device-tree/model");
		},
		...overrides,
	};
}

describe("isRealDevice", () => {
	test("CERALIVE_DEVICE_TYPE=real override → true", async () => {
		const deps = makeDeps({ getDeviceTypeOverride: () => "real" });
		expect(await isRealDevice(deps)).toBe(true);
	});

	test("CERALIVE_DEVICE_TYPE=emulated override → false", async () => {
		const deps = makeDeps({
			getDeviceTypeOverride: () => "emulated",
			readDeviceTreeModel: async () => "Rockchip RK3588",
		});
		expect(await isRealDevice(deps)).toBe(false);
	});

	test("dev/mock mode short-circuits to false before probing hardware", async () => {
		let probed = false;
		const deps = makeDeps({
			isDevelopment: () => true,
			readDeviceTreeModel: async () => {
				probed = true;
				return "Rockchip RK3588";
			},
		});
		expect(await isRealDevice(deps)).toBe(false);
		expect(probed).toBe(false);
	});

	test("device-tree model names an RK3588 board → true", async () => {
		const deps = makeDeps({
			readDeviceTreeModel: async () => "Rockchip RK3588 EVB",
		});
		expect(await isRealDevice(deps)).toBe(true);
	});

	test("device-tree read throws (file absent/unreadable) → false", async () => {
		const deps = makeDeps({
			readDeviceTreeModel: async () => {
				throw new Error("EACCES");
			},
		});
		expect(await isRealDevice(deps)).toBe(false);
	});

	test("unrecognised device-tree model → false (default fail-safe)", async () => {
		const deps = makeDeps({
			readDeviceTreeModel: async () => "Some Generic x86 Board",
		});
		expect(await isRealDevice(deps)).toBe(false);
	});
});
