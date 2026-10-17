import { afterEach, beforeEach, expect, test } from "bun:test";
import { addonRefresh } from "../helpers/addon-helper.ts";
import {
	disableAddon,
	pollAddonCrashLoop,
	setAddonManagerDeps,
} from "../modules/addons/manager.ts";
import { runAddonReconciler } from "../modules/addons/reconciler.ts";
import { getAddons, setAddonState } from "../modules/config.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";
import { heldBoundary, sysextTailFixture } from "./sysext-tail-fixture.ts";

let f: ReturnType<typeof sysextTailFixture>;
beforeEach(() => {
	f = sysextTailFixture();
});
afterEach(() => f.reset());

for (const boundary of ["descriptor", "raw", "fetch"] as const) {
	test(`held reconciler cannot resurrect an uninstalled add-on (${boundary})`, async () => {
		// Given a reconciler held in preparation while the operator removes intent.
		const held = heldBoundary();
		const d = { ...f.reconciler };
		if (boundary === "descriptor")
			d.readDescriptor = async () => {
				await held.wait();
				return sysextDescriptor;
			};
		if (boundary === "raw")
			d.rawExists = async () => {
				await held.wait();
				return false;
			};
		if (boundary === "fetch") d.fetchAndStage = () => held.wait();
		const pass = runAddonReconciler(d);
		await held.entered;
		// When uninstall completes before the held pass returns.
		expect(await disableAddon(sysextDescriptor)).toEqual({
			success: true,
			phase: "disabled",
		});
		expect(getAddons()["cog-display"]).toBeUndefined();
		const afterUninstall = await Bun.file(f.path).bytes();
		held.release();
		await pass;
		// Then no stale publication or refresh resurrects it, including error/fast paths.
		expect(getAddons()["cog-display"]).toBeUndefined();
		expect(await Bun.file(f.path).bytes()).toEqual(afterUninstall);
		expect(f.refreshes).toEqual([]);
		expect(f.frames.at(-1)?.phase).toBe("idle");
	});
}

test("held reconciler cannot undo crash-loop auto-disable", async () => {
	// Given a running add-on and a held refresh preparation.
	const held = heldBoundary();
	setAddonManagerDeps({
		isRealDevice: async () => true,
		getNRestarts: async () => 3,
		systemctl: async () => ({ stdout: "", stderr: "" }),
		broadcast: (_id, state) => {
			f.frames.push(structuredClone(state));
		},
	});
	const pass = runAddonReconciler({
		...f.reconciler,
		fetchAndStage: () => held.wait(),
	});
	await held.entered;
	// When the real safety poll disables it before preparation returns.
	expect(await pollAddonCrashLoop(sysextDescriptor)).toBe("auto_disabled");
	held.release();
	await pass;
	// Then safety intent survives and no sysext refresh occurs.
	expect(getAddons()["cog-display"]).toMatchObject({
		enabled: false,
		phase: "error",
		autoDisabled: true,
		lastError: "addon_crash_loop",
	});
	expect(f.refreshes).toEqual([]);
});

test("deferred raw never publishes active without a refresh", async () => {
	// Given current-OS metadata and raw becoming present before a stream refusal.
	setAddonState("cog-display", {
		enabled: true,
		phase: "active",
		autoDisabled: false,
		osVersionMaterialized: "13",
	});
	await runAddonReconciler({
		...f.reconciler,
		fetchAndStage: async (args) => {
			await f.reconciler.fetchAndStage(args);
			updateStatus(true);
		},
	});
	expect(getAddons()["cog-display"]?.lastError).toBe(
		"addon_refresh_deferred_streaming",
	);
	updateStatus(false);
	// When a later same-process pass finds that raw.
	await runAddonReconciler(f.reconciler);
	// Then active requires a completed refresh rather than presence alone.
	expect(f.refreshes).toEqual(["refresh"]);
	expect(getAddons()["cog-display"]?.phase).toBe("active");
	expect(getAddons()["cog-display"]?.lastError).toBeUndefined();
});

test("typed helper refusal is recorded as deferral", async () => {
	// Given a real helper whose final detection await observes a new stream.
	const d = {
		...f.reconciler,
		refresh: async () => {
			await addonRefresh({
				isRealDevice: async () => {
					updateStatus(true);
					return true;
				},
				exec: async () => {
					f.refreshes.push("refresh");
					return { stdout: "{}", stderr: "" };
				},
			});
		},
	};
	// When reconciliation reaches the real final helper check.
	await runAddonReconciler(d);
	// Then the exact typed refusal is pending deferral, not OS/artifact unavailability.
	expect(getAddons()["cog-display"]?.phase).toBe("pending");
	expect(getAddons()["cog-display"]?.lastError).toBe(
		"addon_refresh_deferred_streaming",
	);
	expect(f.refreshes).toEqual([]);
});
