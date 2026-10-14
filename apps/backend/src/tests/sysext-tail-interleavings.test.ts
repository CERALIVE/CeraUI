import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AddonState } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { addonEnable } from "../helpers/addon-helper.ts";
import {
	currentSysextOperation,
	runDisruptiveSysextStep,
} from "../modules/addons/disruptive-sysext-step.ts";
import {
	disableAddon,
	enableAddon,
	resolveActiveAddonManagerDeps,
	setAddonManagerDeps,
} from "../modules/addons/manager.ts";
import { withAddonMutation } from "../modules/addons/mutation.ts";
import { runAddonReconciler } from "../modules/addons/reconciler.ts";
import {
	getAddons,
	getConfig,
	removeAddonState,
	saveConfig,
} from "../modules/config.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import {
	getKioskLiveState,
	kioskStart,
	kioskStop,
	pollKioskOnce,
	setKioskDeps,
} from "../modules/system/kiosk.ts";
import {
	installAddonProcedure,
	sendAddonSnapshot,
} from "../rpc/procedures/addons.procedure.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";
import { heldBoundary, sysextTailFixture } from "./sysext-tail-fixture.ts";

let f: ReturnType<typeof sysextTailFixture>;
beforeEach(() => {
	f = sysextTailFixture();
});
afterEach(() => f.reset());

for (const boundary of ["helper", "unmask", "start"] as const) {
	test(`enable tail refuses a stream after ${boundary} without claiming active`, async () => {
		// Given stream appearance during one submitted step of a multi-unit tail.
		const effects: string[] = [];
		const deps = resolveActiveAddonManagerDeps();
		setAddonManagerDeps({
			...deps,
			helperEnable: async () => {
				effects.push("helper");
				if (boundary === "helper") updateStatus(true);
			},
			systemctl: async (args) => {
				effects.push(args.join(" "));
				if (args[0] === boundary) updateStatus(true);
				return { stdout: "", stderr: "" };
			},
		});
		const descriptor = {
			...sysextDescriptor,
			units: {
				unmask: ["a.service", "b.service"],
				start: ["a.service", "b.service"],
			},
		};
		// When the next individual disruptive step reaches fresh admission.
		expect(await enableAddon(descriptor)).toEqual({
			success: false,
			error: "streaming",
		});
		// Then no next unit effect occurs and the published terminal state is honestly pending.
		expect(effects).toEqual(
			boundary === "helper"
				? ["helper"]
				: boundary === "unmask"
					? ["helper", "unmask a.service"]
					: [
							"helper",
							"unmask a.service",
							"unmask b.service",
							"start a.service",
						],
		);
		expect(f.frames.at(-1)?.phase).toBe("pending");
		expect(getAddons()["cog-display"]?.versionMaterialized).toBe("1.2.3");
	});
}

for (const boundary of ["stop", "mask"] as const) {
	test(`disable tail rechecks after ${boundary} before the next unit`, async () => {
		// Given a stream appearing in the first unit teardown.
		const effects: string[] = [];
		setAddonManagerDeps({
			...resolveActiveAddonManagerDeps(),
			systemctl: async (args) => {
				effects.push(args.join(" "));
				if (args[0] === boundary) updateStatus(true);
				return { stdout: "", stderr: "" };
			},
			helperDisable: async () => {
				effects.push("helper");
			},
		});
		// When a descriptor with multiple units is disabled.
		expect(
			await disableAddon({
				...sysextDescriptor,
				units: { start: ["a.service", "b.service"] },
			}),
		).toEqual({ success: false, error: "streaming" });
		// Then even later unit effects refuse, and the transitional frame settles.
		expect(effects).toEqual(
			boundary === "stop"
				? ["stop a.service"]
				: ["stop a.service", "mask a.service"],
		);
		expect(f.frames.at(-1)?.phase).toBe("active");
	});
}

test("reinstalled intent supersedes a held pass even when enabled is true again", async () => {
	// Given old prepared intent held across an uninstall and a new install.
	const held = heldBoundary();
	const pass = runAddonReconciler({
		...f.reconciler,
		fetchAndStage: () => held.wait(),
	});
	await held.entered;
	await disableAddon(sysextDescriptor);
	await enableAddon(sysextDescriptor);
	// When the old pass resumes with enabled intent superficially restored.
	held.release();
	await pass;
	// Then the intent revision suppresses the obsolete refresh/publication.
	expect(f.refreshes).toEqual([]);
	expect(getAddons()["cog-display"]?.phase).toBe("active");
});

test("kiosk crash-loop intent supersedes held cog-display reconciliation", async () => {
	// Given kiosk on and cog-display reconciliation held in preparation.
	getConfig().kiosk_enabled = true;
	saveConfig();
	const held = heldBoundary();
	const pass = runAddonReconciler({
		...f.reconciler,
		fetchAndStage: () => held.wait(),
	});
	await held.entered;
	setKioskDeps({
		isFailed: async () => true,
		isActive: async () => false,
		noDisplayMarkerExists: async () => false,
		getNRestarts: async () => 3,
		systemctl: async () => ({ stdout: "", stderr: "" }),
		broadcast: () => undefined,
	});
	// When the real kiosk safety poll masks without sysext refresh.
	expect(await pollKioskOnce()).toBe("disabled");
	held.release();
	await pass;
	// Then neither the display toggle nor the add-on is resurrected.
	expect(getConfig().kiosk_enabled).toBe(false);
	expect(getAddons()["cog-display"]?.autoDisabled).toBe(true);
	expect(f.refreshes).toEqual([]);
});

test("concurrent kiosk stop waits for start and settles disabled", async () => {
	// Given an enable held inside a real kiosk start, with stop queued behind it.
	const held = heldBoundary();
	setAddonManagerDeps({
		...resolveActiveAddonManagerDeps(),
		verify: () => held.wait(),
	});
	const start = kioskStart();
	await held.entered;
	const stop = kioskStop();
	// When the initial mutation finishes and the queue drains.
	held.release();
	await start;
	await stop;
	// Then the later operator intent owns the final state and absent add-on.
	expect(getConfig().kiosk_enabled).toBe(false);
	expect(getKioskLiveState()).toBe("disabled");
	expect(getAddons()["cog-display"]).toBeUndefined();
});

test("nested privileged submission retains one operation identity", async () => {
	// Given a nested direct helper under an admitted sysext operation.
	const identities: symbol[] = [];
	// When the helper reaches injected sudo submission.
	await runDisruptiveSysextStep("outer", async () => {
		const outer = currentSysextOperation();
		if (outer) identities.push(outer.id);
		await addonEnable("cog-display", {
			isRealDevice: async () => true,
			readDescriptor: async () => sysextDescriptor,
			exec: async () => {
				const nested = currentSysextOperation();
				if (nested) identities.push(nested.id);
				return { stdout: "{}", stderr: "" };
			},
		});
	});
	// Then integration can reenter by identity without creating a competing owner.
	expect(identities).toHaveLength(2);
	expect(identities[0]).toBe(identities[1]);
	expect(currentSysextOperation()).toBeUndefined();
});

test("initial hydration corrects an absent add-on retained in the partial subscription map", async () => {
	// Given a client retaining installing while the baked add-on is now absent.
	removeAddonState("cog-display");
	const client: Record<string, AddonState> = {
		"cog-display": { enabled: true, phase: "installing", autoDisabled: false },
	};
	// When the real initial-push producer emits to the same ID-wise merge contract.
	await sendAddonSnapshot((frame) => Object.assign(client, frame));
	// Then explicit idle replaces installing; an empty snapshot would not do so.
	expect(client["cog-display"]).toEqual({
		enabled: false,
		phase: "idle",
		autoDisabled: false,
	});
});

test("RPC preseed refusal publishes original userConfig, not the refused draft", async () => {
	// Given a supplied draft and late refusal during verification.
	setAddonManagerDeps({
		...resolveActiveAddonManagerDeps(),
		verify: async () => {
			updateStatus(true);
		},
	});
	// When the real procedure delegates its preseeded mutation to the manager.
	expect(
		await call(
			installAddonProcedure,
			{ id: "cog-display", userConfig: { preserved: "new" } },
			{ context: buildControlContext() },
		),
	).toEqual({ success: false, error: "streaming" });
	// Then the one terminal frame restores the original state and config.
	expect(f.frames.map((state) => state.phase)).toEqual([
		"installing",
		"active",
	]);
	expect(f.frames.at(-1)?.userConfig).toEqual({ preserved: "old" });
	expect(getAddons()["cog-display"]?.userConfig).toEqual({ preserved: "old" });
});

test("same-ID mutation queue cannot enter a held owner", async () => {
	// Given a held real mutex owner and a queued same-ID callback.
	const held = heldBoundary();
	const effects: string[] = [];
	const owner = withAddonMutation("cog-display", () => held.wait());
	await held.entered;
	const queued = withAddonMutation("cog-display", async () => {
		effects.push("queued");
	});
	// When the deterministic promise-job queue advances, without a timer or deadline.
	await Promise.resolve();
	// Then the next callback cannot enter before positive owner completion.
	expect(effects).toEqual([]);
	held.release();
	await owner;
	await queued;
	expect(effects).toEqual(["queued"]);
});
