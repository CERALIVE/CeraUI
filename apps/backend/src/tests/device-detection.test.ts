/*
 * Task 4 — real-device detection (gating prerequisite for the kiosk RPC, T13).
 *
 * Covers the fail-safe classifier branches in modules/system/device-detection.ts.
 * The detection surface is injected through
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
		readCeraliveRelease: async () => {
			throw new Error("ENOENT: /etc/ceralive/release");
		},
		readDmiProductName: async () => {
			throw new Error("ENOENT: /sys/class/dmi/id/product_name");
		},
		readDmiBoardName: async () => {
			throw new Error("ENOENT: /sys/class/dmi/id/board_name");
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

	test("RK3588 device-tree model names a shipping board → true", async () => {
		const deps = makeDeps({
			readDeviceTreeModel: async () =>
				"Radxa ROCK 5B Plus Board based on Rockchip RK3588",
		});
		expect(await isRealDevice(deps)).toBe(true);
	});

	test.each([
		"Generic Rockchip development board",
		"Rockchip RK3399 reference board",
		"Rockchip RK3568 evaluation board",
	])("unsupported Rockchip model fails closed: %s", async (model) => {
		const deps = makeDeps({
			readDeviceTreeModel: async () => model,
		});
		expect(await isRealDevice(deps)).toBe(false);
	});

	test("x86-minipc CeraLive image identity plus DMI mini-PC marker → true", async () => {
		const deps = makeDeps({
			readCeraliveRelease: async () => 'NAME="CeraLive"\nID=ceralive\n',
			readDmiProductName: async () => "Intel N100 Mini PC",
			readDmiBoardName: async () => "Default string",
		});
		expect(await isRealDevice(deps)).toBe(true);
	});

	test("x86-minipc DMI marker without CeraLive image identity → false", async () => {
		const deps = makeDeps({
			readCeraliveRelease: async () => 'ID=debian\nVERSION_ID="12"\n',
			readDmiProductName: async () => "Intel N100 Mini PC",
			readDmiBoardName: async () => "Default string",
		});
		expect(await isRealDevice(deps)).toBe(false);
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
			readCeraliveRelease: async () => 'NAME="CeraLive"\nID=ceralive\n',
			readDmiProductName: async () => "Workstation",
			readDmiBoardName: async () => "Generic Desktop Board",
		});
		expect(await isRealDevice(deps)).toBe(false);
	});

	test("malformed CeraLive release and stale DMI state fail safe", async () => {
		const deps = makeDeps({
			readCeraliveRelease: async () => "ceralive",
			readDmiProductName: async () => "To Be Filled By O.E.M.",
			readDmiBoardName: async () => "",
		});
		expect(await isRealDevice(deps)).toBe(false);
	});
});
