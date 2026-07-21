/*
 * Todo 59 audit — hardware-kind detection + config-drift guard.
 *
 * Covers `detectHardwareKindFromDeviceTree` (compatible-first, conservative
 * marker matching) and `warnOnHardwareIdentityDrift` (warn-only, isRealDevice
 * gated, unknown-defers). Every probe is injected so no test reads a host file.
 */
import { describe, expect, test } from "bun:test";
import {
	type DeviceDetectionDeps,
	detectHardwareKindFromDeviceTree,
	warnOnHardwareIdentityDrift,
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
		readDeviceTreeCompatible: async () => {
			throw new Error("ENOENT: /proc/device-tree/compatible");
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

describe("detectHardwareKindFromDeviceTree", () => {
	test("Radxa ROCK 5B+ compatible marker → rk3588 (model omits the SoC)", async () => {
		const deps = makeDeps({
			readDeviceTreeModel: async () => "Radxa ROCK 5B+ \n",
			readDeviceTreeCompatible: async () =>
				"radxa,rock-5b-plus\u0000rockchip,rk3588\u0000",
		});
		expect(await detectHardwareKindFromDeviceTree(deps)).toBe("rk3588");
	});

	test("model naming the SoC → rk3588 when compatible is absent", async () => {
		const deps = makeDeps({
			readDeviceTreeModel: async () => "Orange Pi 5 Plus RK3588",
		});
		expect(await detectHardwareKindFromDeviceTree(deps)).toBe("rk3588");
	});

	test("Jetson/Tegra marker → jetson", async () => {
		const deps = makeDeps({
			readDeviceTreeCompatible: async () =>
				"nvidia,p3737-0000\u0000nvidia,tegra234\u0000",
		});
		expect(await detectHardwareKindFromDeviceTree(deps)).toBe("jetson");
	});

	test("x86 DMI N100 marker → n100", async () => {
		const deps = makeDeps({
			readDmiProductName: async () => "Intel N100 Mini PC",
		});
		expect(await detectHardwareKindFromDeviceTree(deps)).toBe("n100");
	});

	test("unsupported Rockchip (RK3399) is NOT mis-stamped rk3588 → unknown", async () => {
		const deps = makeDeps({
			readDeviceTreeModel: async () => "Rockchip RK3399 reference board",
			readDeviceTreeCompatible: async () =>
				"vendor,board\u0000rockchip,rk3399\u0000",
		});
		expect(await detectHardwareKindFromDeviceTree(deps)).toBe("unknown");
	});

	test("all probes absent/unreadable → unknown (never throws)", async () => {
		expect(await detectHardwareKindFromDeviceTree(makeDeps())).toBe("unknown");
	});
});

describe("warnOnHardwareIdentityDrift", () => {
	function makeDriftDeps(overrides: {
		detected: "rk3588" | "jetson" | "n100" | "unknown";
		configuredHw: string;
		isRealDevice?: boolean;
	}) {
		const warnings: string[] = [];
		const deps = {
			detectKind: async () => overrides.detected,
			configuredHw: () => overrides.configuredHw,
			isRealDevice: async () => overrides.isRealDevice ?? true,
			warn: (m: string) => warnings.push(m),
		};
		return { deps, warnings };
	}

	test("matching kind → no warning", async () => {
		const { deps, warnings } = makeDriftDeps({
			detected: "rk3588",
			configuredHw: "rk3588",
		});
		const result = await warnOnHardwareIdentityDrift(deps);
		expect(result).toEqual({ checked: true, drift: false });
		expect(warnings).toHaveLength(0);
	});

	test("positive mismatch (n100 board, rk3588 setup.json) → loud warning", async () => {
		const { deps, warnings } = makeDriftDeps({
			detected: "n100",
			configuredHw: "rk3588",
		});
		const result = await warnOnHardwareIdentityDrift(deps);
		expect(result).toEqual({ checked: true, drift: true });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('hw="rk3588"');
		expect(warnings[0]).toContain('"n100"');
	});

	test("unknown detection defers to config → no warning", async () => {
		const { deps, warnings } = makeDriftDeps({
			detected: "unknown",
			configuredHw: "rk3588",
		});
		const result = await warnOnHardwareIdentityDrift(deps);
		expect(result).toEqual({ checked: true, drift: false });
		expect(warnings).toHaveLength(0);
	});

	test("emulated/dev host is not checked → no warning", async () => {
		const { deps, warnings } = makeDriftDeps({
			detected: "n100",
			configuredHw: "rk3588",
			isRealDevice: false,
		});
		const result = await warnOnHardwareIdentityDrift(deps);
		expect(result).toEqual({ checked: false, drift: false });
		expect(warnings).toHaveLength(0);
	});
});
