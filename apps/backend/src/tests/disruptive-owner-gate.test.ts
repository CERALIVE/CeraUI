import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { notifyDisruptiveActionRefused } from "../modules/system/disruptive-action-refusal.ts";
import {
	reserveDisruptiveAction,
	setDisruptiveUpdateBusySource,
} from "../modules/system/disruptive-action-reservation.ts";
import { getDisruptiveActionDecision } from "../modules/system/disruptive-action-runtime.ts";
import {
	rebootAfterUpdate,
	resetRebootRunner,
	setRebootRunner,
} from "../modules/system/software-updates.ts";
import {
	getOrchestratorDisruptionBusyReasons,
	resetOrchestratorRuntimeForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import * as notifications from "../modules/ui/notifications.ts";

beforeEach(() => {
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
});
afterEach(() => {
	resetOrchestratorRuntimeForTest();
	updateStatus(false);
	updateStreamLifecycleState("idle");
});

test("heldBy ignores only a still-active owner's own reservation", () => {
	// Given a held operation and unrelated owner.
	const owner = Symbol("a");
	reserveDisruptiveAction({ allowed: true }, "service", owner);
	// When the gate evaluates the two identities.
	const own = getDisruptiveActionDecision({ heldBy: owner });
	const other = getDisruptiveActionDecision({ heldBy: Symbol("b") });
	// Then only active ownership grants re-entry.
	expect(own).toEqual({ allowed: true });
	expect(other).toEqual({ allowed: false, reason: "update_in_progress" });
});

test("heldBy refuses a released owner even while no other operation is held", () => {
	// Given completed ownership whose symbol survived.
	const owner = Symbol("a");
	const admission = reserveDisruptiveAction(
		{ allowed: true },
		"service",
		owner,
	);
	if (!admission.allowed) throw new Error("reserve refused");
	admission.reservation.releaseAfterCompletion();
	// When a late descendant rechecks permission.
	const decision = getDisruptiveActionDecision({ heldBy: owner });
	// Then free device state cannot resurrect the old lifetime.
	expect(decision).toEqual({ allowed: false, reason: "update_in_progress" });
});

test("heldBy retains a final streaming refusal", () => {
	// Given active ownership and new live evidence.
	const owner = Symbol("a");
	reserveDisruptiveAction({ allowed: true }, "service", owner);
	updateStatus(true);
	// When its nested step rechecks current liveness.
	const decision = getDisruptiveActionDecision({ heldBy: owner });
	// Then ownership is not a stream-safety bypass.
	expect(decision).toEqual({ allowed: false, reason: "streaming" });
});

test("unregistered update busy source refuses a completion reboot", () => {
	// Given no module registration or successful initialization evidence.
	const env = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	setDisruptiveUpdateBusySource();
	const calls: string[] = [];
	setRebootRunner((command) => {
		calls.push(command);
	});
	try {
		// When the completion-only port evaluates its default source.
		rebootAfterUpdate();
		// Then lack of authority is refusal, not idle permission.
		expect(calls).toEqual([]);
	} finally {
		resetRebootRunner();
		setDisruptiveUpdateBusySource(getOrchestratorDisruptionBusyReasons);
		if (env === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = env;
	}
});

test("pending-action broadcast uses existing generic busy copy without claiming an update", () => {
	// Given a service hold, not a package transaction.
	reserveDisruptiveAction({ allowed: true }, "service");
	const broadcast = spyOn(notifications, "notificationBroadcast");
	try {
		// When the pending-action refusal reaches the local notification port.
		notifyDisruptiveActionRefused("update_in_progress");
		// Then the literal translated key describes generic device busy state.
		expect(broadcast).toHaveBeenCalledWith(
			"disruptive_action_refused",
			"warning",
			expect.any(String),
			10,
			false,
			true,
			false,
			"network.os.deviceBusy",
		);
	} finally {
		broadcast.mockRestore();
	}
});
