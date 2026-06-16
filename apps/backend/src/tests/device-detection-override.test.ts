/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type DeviceDetectionDeps,
	isRealDevice,
	withDeviceType,
} from "../modules/system/device-detection.ts";

describe("device-detection override", () => {
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env.CERALIVE_DEVICE_TYPE;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.CERALIVE_DEVICE_TYPE;
		} else {
			process.env.CERALIVE_DEVICE_TYPE = originalEnv;
		}
	});

	describe("withDeviceType() helper flips isRealDevice() both ways", () => {
		it("flips to real: isRealDevice() returns true inside withDeviceType('real')", async () => {
			await withDeviceType("real", async () => {
				const isReal = await isRealDevice();
				expect(isReal).toBe(true);
			});
		});

		it("flips to emulated: isRealDevice() returns false inside withDeviceType('emulated')", async () => {
			await withDeviceType("emulated", async () => {
				const isReal = await isRealDevice();
				expect(isReal).toBe(false);
			});
		});

		it("restores original env after withDeviceType completes", async () => {
			const before = process.env.CERALIVE_DEVICE_TYPE;
			await withDeviceType("real", async () => {
				expect(process.env.CERALIVE_DEVICE_TYPE).toBe("real");
			});
			expect(process.env.CERALIVE_DEVICE_TYPE).toBe(before);
		});

		it("restores original env even when fn throws", async () => {
			const before = process.env.CERALIVE_DEVICE_TYPE;
			try {
				await withDeviceType("real", async () => {
					throw new Error("test error");
				});
			} catch {
				// expected
			}
			expect(process.env.CERALIVE_DEVICE_TYPE).toBe(before);
		});

		it("clears env when original was undefined", async () => {
			delete process.env.CERALIVE_DEVICE_TYPE;
			await withDeviceType("real", async () => {
				expect(process.env.CERALIVE_DEVICE_TYPE).toBe("real");
			});
			expect(process.env.CERALIVE_DEVICE_TYPE).toBeUndefined();
		});

		it("supports nested withDeviceType calls", async () => {
			await withDeviceType("real", async () => {
				expect(await isRealDevice()).toBe(true);
				await withDeviceType("emulated", async () => {
					expect(await isRealDevice()).toBe(false);
				});
				expect(await isRealDevice()).toBe(true);
			});
		});
	});

	describe("production contract: env override → development false → device-tree probe → false", () => {
		it("env override 'real' returns true (step 1)", async () => {
			const deps: DeviceDetectionDeps = {
				getDeviceTypeOverride: () => "real",
				isDevelopment: () => {
					throw new Error("should not reach isDevelopment");
				},
				readDeviceTreeModel: async () => {
					throw new Error("should not reach readDeviceTreeModel");
				},
			};
			const result = await isRealDevice(deps);
			expect(result).toBe(true);
		});

		it("env override 'emulated' returns false (step 1)", async () => {
			const deps: DeviceDetectionDeps = {
				getDeviceTypeOverride: () => "emulated",
				isDevelopment: () => {
					throw new Error("should not reach isDevelopment");
				},
				readDeviceTreeModel: async () => {
					throw new Error("should not reach readDeviceTreeModel");
				},
			};
			const result = await isRealDevice(deps);
			expect(result).toBe(false);
		});

		it("no override + isDevelopment true returns false (step 2)", async () => {
			const deps: DeviceDetectionDeps = {
				getDeviceTypeOverride: () => undefined,
				isDevelopment: () => true,
				readDeviceTreeModel: async () => {
					throw new Error("should not reach readDeviceTreeModel");
				},
			};
			const result = await isRealDevice(deps);
			expect(result).toBe(false);
		});

		it("no override + isDevelopment false + device-tree contains Rockchip returns true (step 3)", async () => {
			const deps: DeviceDetectionDeps = {
				getDeviceTypeOverride: () => undefined,
				isDevelopment: () => false,
				readDeviceTreeModel: async () => "Rockchip RK3588 Orange Pi 5",
			};
			const result = await isRealDevice(deps);
			expect(result).toBe(true);
		});

		it("no override + isDevelopment false + device-tree contains RK3588 returns true (step 3)", async () => {
			const deps: DeviceDetectionDeps = {
				getDeviceTypeOverride: () => undefined,
				isDevelopment: () => false,
				readDeviceTreeModel: async () => "Some RK3588 Board",
			};
			const result = await isRealDevice(deps);
			expect(result).toBe(true);
		});

		it("no override + isDevelopment false + device-tree read fails returns false (step 4)", async () => {
			const deps: DeviceDetectionDeps = {
				getDeviceTypeOverride: () => undefined,
				isDevelopment: () => false,
				readDeviceTreeModel: async () => {
					throw new Error("file not found");
				},
			};
			const result = await isRealDevice(deps);
			expect(result).toBe(false);
		});

		it("no override + isDevelopment false + unrecognised device-tree returns false (step 5)", async () => {
			const deps: DeviceDetectionDeps = {
				getDeviceTypeOverride: () => undefined,
				isDevelopment: () => false,
				readDeviceTreeModel: async () => "Some Unknown Board",
			};
			const result = await isRealDevice(deps);
			expect(result).toBe(false);
		});

		it("env override takes precedence over isDevelopment true", async () => {
			const deps: DeviceDetectionDeps = {
				getDeviceTypeOverride: () => "real",
				isDevelopment: () => true,
				readDeviceTreeModel: async () => {
					throw new Error("should not reach readDeviceTreeModel");
				},
			};
			const result = await isRealDevice(deps);
			expect(result).toBe(true);
		});

		it("env override takes precedence over device-tree probe", async () => {
			const deps: DeviceDetectionDeps = {
				getDeviceTypeOverride: () => "emulated",
				isDevelopment: () => false,
				readDeviceTreeModel: async () => "Rockchip RK3588 Orange Pi 5",
			};
			const result = await isRealDevice(deps);
			expect(result).toBe(false);
		});
	});

	describe("canonical test pattern for gated subsystems", () => {
		it("kiosk/add-on/SIM subsystems can use withDeviceType in beforeEach/afterEach", async () => {
			let testRanWithReal = false;
			let testRanWithEmulated = false;

			// Simulate a test suite for a gated subsystem
			await withDeviceType("real", async () => {
				const isReal = await isRealDevice();
				if (isReal) testRanWithReal = true;
			});

			await withDeviceType("emulated", async () => {
				const isReal = await isRealDevice();
				if (!isReal) testRanWithEmulated = true;
			});

			expect(testRanWithReal).toBe(true);
			expect(testRanWithEmulated).toBe(true);
		});
	});
});
