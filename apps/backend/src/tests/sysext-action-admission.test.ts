import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import { disableAddon, enableAddon } from "../modules/addons/manager.ts";
import { runAddonReconciler } from "../modules/addons/reconciler.ts";
import { getConfig, saveConfig } from "../modules/config.ts";
import { createSeenCidStore } from "../modules/remote-control/command-idempotency.ts";
import { routeCommand } from "../modules/remote-control/command-router.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import type { Command, Result } from "../modules/remote-control/protocol.ts";
import { resetSelfFencingState } from "../modules/remote-control/self-fencing.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import * as admissionRuntime from "../modules/system/disruptive-action-runtime.ts";
import { kioskStart, kioskStop } from "../modules/system/kiosk.ts";
import { markBootDegraded } from "../modules/system/readiness.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";
import { setOrchestratorStateForTest } from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	installAddonProcedure,
	uninstallAddonProcedure,
} from "../rpc/procedures/addons.procedure.ts";
import {
	kioskStartProcedure,
	kioskStopProcedure,
} from "../rpc/procedures/system.procedure.ts";
import { sysextDescriptor, sysextFixture } from "./sysext-action-fixture.ts";

let fixture: ReturnType<typeof sysextFixture>;
beforeEach(() => {
	fixture = sysextFixture();
});
afterEach(() => {
	fixture.reset();
	resetSelfFencingState();
});
const context = buildControlContext();

const entries = {
	"manager enable": () => enableAddon(sysextDescriptor),
	"manager disable": () => disableAddon(sysextDescriptor),
	"RPC install with userConfig": () =>
		call(
			installAddonProcedure,
			{ id: "cog-display", userConfig: { preserved: "new" } },
			{ context },
		),
	"RPC uninstall": () =>
		call(uninstallAddonProcedure, { id: "cog-display" }, { context }),
	"RPC kiosk start": () => call(kioskStartProcedure, undefined, { context }),
	"RPC kiosk stop": () => call(kioskStopProcedure, undefined, { context }),
} as const;
const refused = [
	{ label: "live", error: "streaming", arrange: () => updateStatus(true) },
	{
		label: "unknown",
		error: "stream_liveness_unknown",
		arrange: () => updateStreamLifecycleState("reconciling"),
	},
	{
		label: "boot unreconciled",
		error: "stream_liveness_unknown",
		arrange: () => setStreamReconciliationCompletedForTest(false),
	},
	{
		label: "update",
		error: "update_in_progress",
		arrange: () =>
			setOrchestratorStateForTest({
				...initialOrchestratorState(1),
				phase: "os-staging",
			}),
	},
	{
		label: "maintenance",
		error: "update_in_progress",
		arrange: () => markBootDegraded("update-orchestrator-maintenance"),
	},
] as const;

for (const [name, action] of Object.entries(entries)) {
	for (const state of refused) {
		test(`${name} refuses ${state.label} before effects and preserves state bytes`, async () => {
			// Given independently driven runtime evidence and a persisted baseline.
			state.arrange();
			const before = await Bun.file(fixture.path).bytes();
			const inMemory = JSON.stringify(getConfig());
			// When the real entry is called.
			const result = await action();
			// Then the existing wire refusal is honest and neither intent nor effects change.
			expect(result).toEqual({ success: false, error: state.error });
			expect(fixture.effects).toEqual([]);
			expect(await Bun.file(fixture.path).bytes()).toEqual(before);
			expect(JSON.stringify(getConfig())).toBe(inMemory);
		});
	}
	test(`${name} allows confirmed idle and retains activation behaviour`, async () => {
		// Given confirmed idle, no update and enough space.
		// When the real entry executes.
		const result = await action();
		// Then the original helper pipeline executes, not a refusal-only stub.
		expect(result.success).toBe(true);
		expect(fixture.effects).toContain(
			name.includes("disable") ||
				name.includes("uninstall") ||
				name.includes("stop")
				? "helper-disable"
				: "helper-enable",
		);
	});
}

for (const [name, action] of Object.entries({
	"direct kiosk start": kioskStart,
	"direct kiosk stop": kioskStop,
})) {
	for (const state of refused) {
		test(`${name} refuses ${state.label} before its synchronous intent prelude`, async () => {
			// Given an unconfirmed-idle device.
			state.arrange();
			const before = await Bun.file(fixture.path).bytes();
			const inMemory = JSON.stringify(getConfig());
			// When a non-RPC caller attempts the toggle.
			let reason: string | undefined;
			try {
				await action();
			} catch (error) {
				if (!(error instanceof Error)) throw error;
				reason = error.message;
			}
			// Then admission precedes intent, broadcast, polling and materialisation.
			expect(reason).toBe(state.error);
			expect(fixture.effects).toEqual([]);
			expect(await Bun.file(fixture.path).bytes()).toEqual(before);
			expect(JSON.stringify(getConfig())).toBe(inMemory);
		});
	}
}

test("kiosk stop refuses live without erasing an enabled intent", async () => {
	// Given enabled kiosk state, saved before the stream goes live.
	Object.assign(getConfig(), {
		kiosk_enabled: true,
		kiosk_last_state: "enabled-running",
	});
	saveConfig();
	updateStatus(true);
	const before = await Bun.file(fixture.path).bytes();
	// When the real RPC attempts to disable it.
	const result = await call(kioskStopProcedure, undefined, { context });
	// Then the enabled intent survives byte-for-byte.
	expect(result).toEqual({ success: false, error: "streaming" });
	expect(await Bun.file(fixture.path).bytes()).toEqual(before);
	expect(getConfig().kiosk_enabled).toBe(true);
	expect(fixture.effects).toEqual([]);
});

for (const state of refused) {
	test(`reconciler defers ${state.label} even when its legacy live flag is false`, async () => {
		// Given a stale wanted add-on and independent authoritative runtime evidence.
		state.arrange();
		const effects: string[] = [];
		// When a startup/SIGUSR1 reconciliation runs through the real decision body.
		await runAddonReconciler({
			isRealDevice: async () => true,
			getIsStreaming: () => false,
			getOsVersionId: async () => "13",
			getBoard: () => "rk3588",
			getAddons: () => ({
				"cog-display": { enabled: true, phase: "active", autoDisabled: false },
			}),
			readDescriptor: async () => sysextDescriptor,
			rawExists: async () => false,
			fetchAndStage: async () => {
				effects.push("fetch");
			},
			refresh: async () => {
				effects.push("refresh");
			},
			setState: () => {},
			log: () => {},
		});
		// Then an advisory false flag cannot permit either disruptive effect.
		expect(effects).toEqual([]);
	});
}

test("local sysext entries and remote reboot consume the same public admission adapter", async () => {
	// Given a refusal supplied at the single public composition seam, not a copied predicate.
	const adapter = spyOn(
		admissionRuntime,
		"getDisruptiveActionDecision",
	).mockReturnValue({ allowed: false, reason: "stream_liveness_unknown" });
	const frames: Result[] = [];
	const frame: Command = {
		v: 1,
		kind: "command",
		type: "system.reboot",
		cid: "b3b-parity",
		role: "owner",
	};
	try {
		// When all local entries and the real remote receipt route run.
		for (const action of Object.values(entries)) {
			expect(await action()).toEqual({
				success: false,
				error: "stream_liveness_unknown",
			});
		}
		await routeCommand(frame, {
			context,
			seenCids: createSeenCidStore(),
			sendResult: (result) => frames.push(result) > 0,
			sendDeliveryAck: () => true,
		});
		// Then every path consumes that adapter and no local effect is submitted.
		expect(adapter).toHaveBeenCalledTimes(7);
		expect(frames.at(-1)?.payload.error).toBe("stream_liveness_unknown");
		expect(fixture.effects).toEqual([]);
	} finally {
		adapter.mockRestore();
	}
});

for (const type of [
	"addons.install",
	"addons.uninstall",
	"addons.enable",
	"addons.disable",
	"addons.update",
	"system.kioskStart",
	"system.kioskStop",
]) {
	test(`remote ${type} cannot reach a sysext even with a dispatch override`, async () => {
		// Given an unregistered operation and a deliberately tempting effect port.
		const frames: Result[] = [];
		// When it reaches the real closed-registry router.
		await routeCommand(
			{ v: 1, kind: "command", type, cid: `b3b-${type}`, role: "owner" },
			{
				context,
				seenCids: createSeenCidStore(),
				sendDeliveryAck: () => true,
				sendResult: (result) => frames.push(result) > 0,
				dispatch: {
					[type]: async () => {
						fixture.effects.push("remote-effect");
						return { success: true };
					},
				},
			},
		);
		// Then the wire rejects it before dispatch, regardless of idle/live state.
		expect(frames.at(-1)?.payload).toEqual({
			ok: false,
			applied: null,
			error: "unknown_command",
		});
		expect(fixture.effects).toEqual([]);
	});
}
