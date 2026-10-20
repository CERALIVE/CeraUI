import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AddonState } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	disableAddon,
	enableAddon,
	getAddonPhase,
	initAddonManager,
	resolveActiveAddonManagerDeps,
	setAddonManagerDeps,
} from "../modules/addons/manager.ts";
import { runAddonReconciler } from "../modules/addons/reconciler.ts";
import { getAddons, setAddonState } from "../modules/config.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	configureAddonProcedure,
	installAddonProcedure,
	resetAddonProcedureDeps,
	sendAddonSnapshot,
	setAddonProcedureDeps,
} from "../rpc/procedures/addons.procedure.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";
import { heldBoundary, sysextTailFixture } from "./sysext-tail-fixture.ts";

let f: ReturnType<typeof sysextTailFixture>;
beforeEach(() => {
	f = sysextTailFixture();
});
afterEach(() => f.reset());

test("configuration supersedes pending persistence without replaying stale userConfig", async () => {
	// Given a terminal EIO retained in the real settlement owner.
	let broken = true;
	setAddonManagerDeps({
		...resolveActiveAddonManagerDeps(),
		setState: (id, state) => {
			if (broken && state.phase === "active") throw new Error("terminal EIO");
			setAddonState(id, state);
		},
	});
	expect(await enableAddon(sysextDescriptor)).toEqual({
		success: false,
		error: "addon_enable_failed",
	});
	broken = false;
	resetAddonProcedureDeps();
	setAddonProcedureDeps({
		isRealDevice: async () => true,
		readDescriptors: async () => [sysextDescriptor],
		getEffectiveHardware: () => "rk3588",
	});
	// When the real configure procedure commits newer configuration and a refused mutation retries.
	expect(
		await call(
			configureAddonProcedure,
			{ id: "cog-display", fields: { preserved: "newer" } },
			{ context: buildControlContext() },
		),
	).toEqual({ success: true, applied: { preserved: "newer" } });
	updateStatus(true);
	await enableAddon(sysextDescriptor);
	// Then old pending persistence cannot overwrite the newer config.
	expect(getAddons()["cog-display"]?.userConfig).toEqual({
		preserved: "newer",
	});
	expect(f.frames.at(-1)?.userConfig).toEqual({ preserved: "newer" });
});

test("hydration settles predecessor work even before optional manager initialization", async () => {
	// Given the early authenticated boot window with predecessor disabling on disk.
	setAddonState("cog-display", {
		enabled: false,
		phase: "disabling",
		autoDisabled: false,
	});
	// When hydration occurs before optional add-on subsystem startup.
	let hydrated: Record<string, AddonState> = {};
	await sendAddonSnapshot((s) => {
		hydrated = s;
	});
	// Then a dead operation cannot appear busy in the early boot window.
	expect(hydrated["cog-display"]).toEqual({
		enabled: false,
		phase: "error",
		autoDisabled: false,
		lastError: "addon_disable_failed",
	});
});

test("hydration preserves a transitional phase owned by a live mutation", async () => {
	// Given a live manager enable, unlike a predecessor's interrupted operation.
	const held = heldBoundary();
	setAddonManagerDeps({
		...resolveActiveAddonManagerDeps(),
		verify: () => held.wait(),
	});
	const enable = enableAddon(sysextDescriptor);
	await held.entered;
	let hydrated: Record<string, AddonState> = {};
	// When hydration observes the still-active owner.
	await sendAddonSnapshot((s) => {
		hydrated = s;
	});
	held.release();
	await enable;
	// Then it may report installing without clearing a real operation.
	expect(hydrated["cog-display"]?.phase).toBe("installing");
});

test("an RPC refusal after activation does not overwrite the manager's settlement", async () => {
	// Given replacement bytes activated by the manager before the unit tail loses idle.
	setAddonManagerDeps({
		...resolveActiveAddonManagerDeps(),
		helperEnable: async () => {
			await Bun.write(f.raw, "replacement-payload");
			updateStatus(true);
		},
	});
	// When the REAL install procedure supplies a new userConfig.
	const result = await call(
		installAddonProcedure,
		{ id: "cog-display", userConfig: { preserved: "new" } },
		{ context: buildControlContext() },
	);
	// Then config, live phase and terminal frame all describe actual activation.
	expect(result).toEqual({ success: false, error: "streaming" });
	expect(f.frames.map((s) => s.phase)).toEqual(["installing", "pending"]);
	expect(getAddons()["cog-display"]).toEqual({
		enabled: true,
		phase: "pending",
		autoDisabled: false,
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "13",
		userConfig: { preserved: "new" },
		lastError: "addon_refresh_deferred_streaming",
	});
	expect(
		JSON.parse(await Bun.file(f.path).text()).addons["cog-display"],
	).toEqual(f.frames.at(-1));
	expect(getAddonPhase("cog-display")).toBe("pending");
	expect(await f.readRaw()).toBe("replacement-payload");
});

for (const phase of ["installing", "disabling"] as const) {
	test(`an interrupted ${phase} add-on hydrates non-busy`, async () => {
		// Given schema-valid predecessor intent with no live operation in this process.
		const enabled = phase === "installing";
		setAddonState("cog-display", {
			enabled,
			phase,
			autoDisabled: false,
			versionMaterialized: "1.0.0",
			osVersionMaterialized: "13",
		});
		// When actual manager startup settles and the actual hydration producer sends.
		initAddonManager();
		let hydrated: Record<string, AddonState> = {};
		await sendAddonSnapshot((s) => {
			hydrated = s;
		});
		// Then the dead operation is unresolved, not permanently busy or falsely successful.
		expect(hydrated["cog-display"]).toMatchObject({
			enabled,
			phase: enabled ? "pending" : "error",
			autoDisabled: false,
			lastError: enabled ? "addon_enable_failed" : "addon_disable_failed",
		});
		expect(getAddons()["cog-display"]?.phase).toBe(
			enabled ? "pending" : "error",
		);
		await runAddonReconciler(f.reconciler);
		expect(f.refreshes).toEqual(enabled ? ["refresh"] : []);
	});
}

for (const failure of [
	"refusal",
	"verification",
	"disable",
	"disable-error",
	"success",
] as const) {
	test(`a failed terminal persistence still broadcasts a terminal frame (${failure})`, async () => {
		// Given successful transitional persistence and EIO on every terminal write/delete.
		const before = await Bun.file(f.path).text();
		let broken = true;
		const disabling = failure === "disable" || failure === "disable-error";
		setAddonManagerDeps({
			...resolveActiveAddonManagerDeps(),
			verify: async () => {
				if (failure === "refusal") updateStatus(true);
				if (failure === "verification") throw new Error("verification failed");
			},
			helperDisable: async () => {
				if (failure === "disable-error")
					throw new Error("disable helper failed");
			},
			setState: (id, state) => {
				if (
					broken &&
					state.phase !== "installing" &&
					state.phase !== "disabling"
				)
					throw Object.assign(new Error("terminal write EIO"), { code: "EIO" });
				setAddonState(id, state);
			},
			removeState: () => {
				if (broken) throw new Error("terminal delete EIO");
			},
		});
		// When the REAL manager reaches any terminal settlement boundary.
		const result = await (disabling ? disableAddon : enableAddon)(
			sysextDescriptor,
		);
		// Then EIO cannot strand the subscriber busy or turn into a successful RPC.
		expect(result).toEqual({
			success: false,
			error: disabling ? "addon_disable_failed" : "addon_enable_failed",
		});
		expect(f.frames.map((s) => s.phase)).toEqual([
			disabling ? "disabling" : "installing",
			"error",
		]);
		expect(f.frames.at(-1)?.lastError).toBe(
			disabling ? "addon_disable_failed" : "addon_enable_failed",
		);
		expect(getAddonPhase("cog-display")).toBe("failed");
		expect(await Bun.file(f.path).text()).not.toBe(before);
		expect(
			JSON.parse(await Bun.file(f.path).text()).addons["cog-display"].phase,
		).toBe(disabling ? "disabling" : "installing");
		let hydrated: Record<string, AddonState> = {};
		await sendAddonSnapshot((s) => {
			hydrated = s;
		});
		expect(hydrated["cog-display"]?.phase).toBe("error");
		// Then repair permits retrying persistence even on an upfront refused mutation.
		broken = false;
		updateStatus(true);
		await enableAddon(sysextDescriptor);
		expect(getAddons()["cog-display"]?.phase).toBe("error");
	});
}
