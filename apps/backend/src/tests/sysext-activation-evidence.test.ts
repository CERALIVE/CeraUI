import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	enableAddon,
	initAddonManager,
	resolveActiveAddonManagerDeps,
	setAddonManagerDeps,
} from "../modules/addons/manager.ts";
import { runAddonReconciler } from "../modules/addons/reconciler.ts";
import { getAddons, setAddonState } from "../modules/config.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";
import { sysextTailFixture } from "./sysext-tail-fixture.ts";

let f: ReturnType<typeof sysextTailFixture>;
beforeEach(() => {
	f = sysextTailFixture();
});
afterEach(() => f.reset());

test("helper failure after publication never becomes active from raw presence", async () => {
	// Given the UNCHANGED Bash helper with private registry/cache/scan and real jq/hash.
	const registry = join(f.root, "registry");
	const cache = join(f.root, "cache");
	await mkdir(registry);
	await mkdir(cache);
	await mkdir(f.scan);
	await Bun.write(f.raw, "prior-payload");
	await Bun.write(join(cache, "cog-display.raw"), "replacement-payload");
	await Bun.write(join(cache, "cog-display.raw.sig"), "signature-tool-sink");
	const descriptor = {
		...sysextDescriptor,
		artifact: {
			...sysextDescriptor.artifact,
			sha256: new Bun.CryptoHasher("sha256")
				.update("replacement-payload")
				.digest("hex"),
		},
	};
	await Bun.write(
		join(registry, "cog-display.json"),
		JSON.stringify(descriptor),
	);
	setAddonState("cog-display", {
		enabled: true,
		phase: "active",
		autoDisabled: false,
		versionMaterialized: "1.0.0",
		osVersionMaterialized: "13",
	});
	let childExit: number | undefined;
	setAddonManagerDeps({
		...resolveActiveAddonManagerDeps(),
		helperEnable: async () => {
			const result = await runTestCommand(
				[
					"/bin/bash",
					join(import.meta.dir, "../../ceralive-addon-helper"),
					"enable",
					"cog-display",
				],
				{
					env: {
						CERALIVE_ADDON_REGISTRY_DIR: registry,
						CERALIVE_ADDON_CACHE_DIR: cache,
						CERALIVE_ADDON_STAGE_DIR: f.scan,
						CERALIVE_ADDON_EXT_DIR: f.scan,
						CERALIVE_GPGV: "/usr/bin/true",
						CERALIVE_SYSTEMCTL: "/usr/bin/true",
						CERALIVE_SYSEXT: "/usr/bin/false",
					},
				},
			);
			childExit = result.code;
			if (result.code !== 0) throw new Error("helper refresh failed");
		},
	});
	// When the real manager observes the helper's ordinary refresh failure.
	expect(await enableAddon(descriptor)).toEqual({
		success: false,
		error: "addon_enable_failed",
	});
	expect(childExit).toBe(1);
	expect(await f.readRaw()).toBe("replacement-payload");
	expect(f.frames.map((s) => s.phase)).toEqual(["installing", "error"]);
	expect(getAddons()["cog-display"]?.versionMaterialized).toBeUndefined();
	expect(getAddons()["cog-display"]?.osVersionMaterialized).toBeUndefined();
	initAddonManager();
	await runAddonReconciler(f.reconciler);
	// Then a fresh refresh is required before activation, including after startup replay.
	expect(f.refreshes).toEqual(["refresh"]);
	expect(getAddons()["cog-display"]).toMatchObject({
		phase: "active",
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "13",
	});
	expect(await f.readRaw()).toBe("reconciler-payload");
});

for (const baseline of [
	{
		phase: "active",
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "13",
		refresh: false,
	},
	{
		phase: "error",
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "13",
		refresh: true,
	},
	{
		phase: "installing",
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "13",
		refresh: true,
	},
	{
		phase: "active",
		versionMaterialized: "1.0.0",
		osVersionMaterialized: "13",
		refresh: true,
	},
	{
		phase: "active",
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "12",
		refresh: true,
	},
	{
		phase: "active",
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "13",
		lastError: "addon_enable_failed",
		refresh: true,
	},
] as const) {
	test(`raw presence requires settled activation evidence (${JSON.stringify(baseline)})`, async () => {
		// Given real scan bytes with independently specified activation evidence.
		await mkdir(f.scan);
		await Bun.write(f.raw, "unqualified-raw");
		const { refresh, ...metadata } = baseline;
		setAddonState("cog-display", {
			enabled: true,
			autoDisabled: false,
			...metadata,
		});
		// When the real reconciler handles this baseline.
		await runAddonReconciler(f.reconciler);
		// Then only the literal settled cell avoids refreshing.
		expect(f.refreshes).toEqual(refresh ? ["refresh"] : []);
		expect(getAddons()["cog-display"]?.phase).toBe("active");
	});
}
