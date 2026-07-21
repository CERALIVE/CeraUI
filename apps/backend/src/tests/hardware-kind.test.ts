/*
 * Resolved hardware-kind provider (Todo 15 consumer migration).
 *
 * Covers the four-tier resolution ladder (engine → device-tree → setup.hw →
 * generic), the cache + re-resolution drift warning, the sync cached read's
 * setup.hw fallback before first resolve, and each migrated consumer under
 * mocked kinds (byte-identical rk3588 behavior asserted).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getAudioSrcId } from "../modules/streaming/audio.ts";
import {
	getEffectiveHardware,
	getMockHardware,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import type { DetectedHardwareKind } from "../modules/system/device-detection.ts";
import {
	getHardwareKind,
	getHardwareKindCached,
	getHardwareKindTier,
	type HardwareKind,
	type HardwareKindResolveDeps,
	resetHardwareKindCache,
} from "../modules/system/hardware-kind.ts";

function makeDeps(overrides: {
	engine?: HardwareKind | undefined;
	deviceTree?: DetectedHardwareKind;
	configuredHw?: string;
}): { deps: Partial<HardwareKindResolveDeps>; warnings: string[] } {
	const warnings: string[] = [];
	const deps: Partial<HardwareKindResolveDeps> = {
		probeEngine: async () => overrides.engine,
		detectFromDeviceTree: async () => overrides.deviceTree ?? "unknown",
		getConfiguredHw: () => overrides.configuredHw ?? "rk3588",
		warn: (m) => warnings.push(m),
		debug: () => {},
	};
	return { deps, warnings };
}

describe("getHardwareKind — resolution-order table", () => {
	beforeEach(() => resetHardwareKindCache());
	afterEach(() => resetHardwareKindCache());

	test("engine present → engine tier wins over device-tree and setup.hw", async () => {
		const { deps } = makeDeps({
			engine: "n100",
			deviceTree: "rk3588",
			configuredHw: "jetson",
		});
		expect(await getHardwareKind(deps)).toBe("n100");
		expect(getHardwareKindTier()).toBe("engine");
	});

	test("engine absent → device-tree tier wins over setup.hw", async () => {
		const { deps } = makeDeps({
			engine: undefined,
			deviceTree: "n100",
			configuredHw: "rk3588",
		});
		expect(await getHardwareKind(deps)).toBe("n100");
		expect(getHardwareKindTier()).toBe("device-tree");
	});

	test("engine absent + device-tree unknown → setup.hw fallback tier", async () => {
		const { deps } = makeDeps({
			engine: undefined,
			deviceTree: "unknown",
			configuredHw: "jetson",
		});
		expect(await getHardwareKind(deps)).toBe("jetson");
		expect(getHardwareKindTier()).toBe("setup.hw");
	});

	test("all tiers empty/invalid → generic floor", async () => {
		const { deps } = makeDeps({
			engine: undefined,
			deviceTree: "unknown",
			configuredHw: "totally-unknown-board",
		});
		expect(await getHardwareKind(deps)).toBe("generic");
		expect(getHardwareKindTier()).toBe("generic");
	});
});

describe("getHardwareKind — cache invalidation + drift warning", () => {
	beforeEach(() => resetHardwareKindCache());
	afterEach(() => resetHardwareKindCache());

	test("boot-without-engine → DT tier; engine recovers with differing value → engine wins + drift warning fires", async () => {
		// Boot: cerastream down → device-tree names the real board (n100), while
		// setup.hw is the mismatched image default (rk3588).
		const boot = makeDeps({
			engine: undefined,
			deviceTree: "n100",
			configuredHw: "rk3588",
		});
		expect(await getHardwareKind(boot.deps)).toBe("n100");
		expect(getHardwareKindTier()).toBe("device-tree");
		expect(boot.warnings).toHaveLength(0);

		// Engine recovers reporting a DIFFERENT kind → engine tier wins + drift warns.
		const healWarnings: string[] = [];
		const healed = await getHardwareKind({
			probeEngine: async () => "rk3588",
			detectFromDeviceTree: async () => "n100",
			getConfiguredHw: () => "rk3588",
			warn: (m) => healWarnings.push(m),
			debug: () => {},
		});
		expect(healed).toBe("rk3588");
		expect(getHardwareKindTier()).toBe("engine");
		expect(healWarnings).toHaveLength(1);
		expect(healWarnings[0]).toContain('was "n100"');
		expect(healWarnings[0]).toContain('"rk3588"');
	});

	test("re-resolution with the SAME kind fires no drift warning", async () => {
		const first = makeDeps({ engine: "rk3588" });
		await getHardwareKind(first.deps);
		const second = makeDeps({ engine: "rk3588" });
		await getHardwareKind(second.deps);
		expect(second.warnings).toHaveLength(0);
		expect(getHardwareKindTier()).toBe("engine");
	});

	test("first resolution never fires a drift warning (cache was empty)", async () => {
		const { deps, warnings } = makeDeps({ engine: "n100" });
		await getHardwareKind(deps);
		expect(warnings).toHaveLength(0);
	});
});

describe("getHardwareKindCached — sync read", () => {
	beforeEach(() => resetHardwareKindCache());
	afterEach(() => resetHardwareKindCache());

	test("before first resolve → setup.hw fallback (rk3588 test host)", () => {
		expect(getHardwareKindCached()).toBe("rk3588");
		expect(getHardwareKindTier()).toBeUndefined();
	});

	test("after resolve → the cached kind", async () => {
		const { deps } = makeDeps({ engine: "n100" });
		await getHardwareKind(deps);
		expect(getHardwareKindCached()).toBe("n100");
	});
});

describe("consumer: pipelines.getEffectiveHardware under mocked kinds", () => {
	// pipelines carries a process-wide mock override with no clear-to-null seam, so
	// the un-overridden path (which getEffectiveHardware() takes absent an override)
	// is asserted through getHardwareKindCached() — the exact value it reads — to
	// stay independent of any override another test file may have left set.
	beforeEach(() => resetHardwareKindCache());
	afterEach(() => resetHardwareKindCache());

	test("no cache → getEffectiveHardware source is the setup.hw fallback (byte-identical to pre-migration)", () => {
		expect(getHardwareKindCached()).toBe("rk3588");
	});

	test("resolved engine kind is the source getEffectiveHardware reads (absent an override)", async () => {
		const { deps } = makeDeps({ engine: "n100" });
		await getHardwareKind(deps);
		expect(getHardwareKindCached()).toBe("n100");
		if (getMockHardware() === null) {
			expect(getEffectiveHardware()).toBe("n100");
		}
	});

	test("mock override wins over the resolved kind (dev seam preserved)", async () => {
		const { deps } = makeDeps({ engine: "n100" });
		await getHardwareKind(deps);
		expect(setMockHardware("jetson")).toBe(true);
		expect(getEffectiveHardware()).toBe("jetson");
	});
});

describe("consumer: audio alias resolution under mocked kinds", () => {
	beforeEach(() => resetHardwareKindCache());
	afterEach(() => resetHardwareKindCache());

	test("rk3588 resolved → rk3588 audio aliases active (HDMI label present, byte-identical)", async () => {
		const { deps } = makeDeps({ engine: "rk3588" });
		await getHardwareKind(deps);
		expect(getAudioSrcId("HDMI")).toBe("rockchiphdmiin");
		expect(getAudioSrcId("Analog in")).toBe("rockchipes8388");
		expect(getAudioSrcId("USB audio")).toBe("usbaudio");
	});

	test("n100 resolved → rk3588 aliases NOT applied (a mismatched image no longer stamps HDMI)", async () => {
		const { deps } = makeDeps({ engine: "n100" });
		await getHardwareKind(deps);
		// The rk3588-only reverse alias no longer resolves; "HDMI" is passed through.
		expect(getAudioSrcId("HDMI")).toBe("HDMI");
		expect(getAudioSrcId("Analog in")).toBe("Analog in");
		// The base aliases stay active on every board.
		expect(getAudioSrcId("USB audio")).toBe("usbaudio");
	});
});
