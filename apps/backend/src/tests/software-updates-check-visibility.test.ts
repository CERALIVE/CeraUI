/*
 * Checking for updates must never be a no-op the operator cannot see.
 *
 * Found live on a Rock 5B+ (`apt list --upgradable` genuinely empty): clicking
 * "Check for updates" in Settings → Software Updates changed NOTHING for 11 s —
 * `aria-busy` stayed false, the label never became "Checking…", the summary
 * stayed "System is up to date". The device had in fact done the work:
 * `/opt/ceralive/debug.log` recorded `System: manual software update check
 * started` at 03:52:31.441 and `apt-get update: success` at 03:52:33.267.
 *
 * The check ran; only its RESULT was unobservable. Three gaps, all here:
 *
 *   1. `aptGetUpdating = true` was set with no broadcast, so `kind:'checking'`
 *      was derivable server-side yet never published — no client could witness a
 *      check in flight.
 *   2. A completed check that changed nothing re-broadcast a byte-identical
 *      state, leaving no evidence at all that it had run.
 *   3. A check that genuinely FAILED never reached `update_state`: a failed
 *      `apt-get update` still let discovery parse the STALE package lists, which
 *      report "0 upgraded", so the device confidently answered "System is up to
 *      date" when it had not managed to check anything.
 *
 * These tests pin the properties that make all three impossible: a check that
 * cannot reach a verdict says so, a completed check leaves proof it ran, and a
 * refused check never claims to have checked.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call } from "@orpc/server";

import { setup } from "../modules/setup.ts";
import {
	getUpdateState,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateSizeRunner,
	resetSoftwareUpdateState,
	setSoftwareUpdateCheckRunner,
	setSoftwareUpdateSizeRunner,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import {
	deriveUpdateState,
	type UpdateSnapshot,
} from "../modules/system/update-state.ts";
import { checkForUpdatesProcedure } from "../rpc/procedures/system.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function snapshot(overrides: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
	return {
		checking: false,
		available: null,
		updating: null,
		failure: null,
		succeeded: false,
		checkFailure: null,
		checkedAt: null,
		...overrides,
	};
}

const IDENTITY = { version: "abc123", packages: ["cerastream"] };

describe("deriveUpdateState() — a check that cannot reach a verdict says so", () => {
	test("a failed refresh reports check_failed, NOT 'up to date'", () => {
		// The exact live shape: apt-get update could not reach the repos, so
		// discovery's "0 upgraded" against stale lists proves nothing.
		expect(
			deriveUpdateState(
				snapshot({ checkFailure: "refresh_failed", checkedAt: 1000 }),
			),
		).toEqual({
			kind: "check_failed",
			reason: "refresh_failed",
			checked_at: 1000,
		});
	});

	test("an unreadable discovery reports check_failed too", () => {
		expect(
			deriveUpdateState(
				snapshot({ checkFailure: "discovery_failed", checkedAt: 1000 }),
			),
		).toEqual({
			kind: "check_failed",
			reason: "discovery_failed",
			checked_at: 1000,
		});
	});

	test("a known-available update survives a later failed refresh", () => {
		// Deliberate precedence: we already PROVED an update exists, so it stays
		// installable even though a later refresh could not confirm it.
		expect(
			deriveUpdateState(
				snapshot({
					available: { identity: IDENTITY, package_count: 2 },
					checkFailure: "refresh_failed",
					checkedAt: 1000,
				}),
			),
		).toEqual({
			kind: "available",
			identity: IDENTITY,
			package_count: 2,
			checked_at: 1000,
		});
	});

	test("a failed INSTALL still outranks a failed check", () => {
		expect(
			deriveUpdateState(
				snapshot({
					failure: { reason: "dpkg was interrupted" },
					checkFailure: "refresh_failed",
				}),
			),
		).toEqual({ kind: "failed", reason: "dpkg was interrupted" });
	});

	test("a check in flight supersedes the previous cycle's failure", () => {
		expect(
			deriveUpdateState(
				snapshot({ checking: true, checkFailure: "refresh_failed" }),
			),
		).toEqual({ kind: "checking" });
	});
});

describe("deriveUpdateState() — a completed check leaves proof it ran", () => {
	test("idle carries the checked_at stamp", () => {
		expect(deriveUpdateState(snapshot({ checkedAt: 1712345 }))).toEqual({
			kind: "idle",
			checked_at: 1712345,
		});
	});

	test("a device that has never checked carries no stamp", () => {
		// Absent must stay absent — a fabricated timestamp would be worse than none.
		expect(deriveUpdateState(snapshot())).toEqual({ kind: "idle" });
	});
});

describe("triggerManualUpdateCheck() — the operator's click is accounted for", () => {
	let savedAptEnabled: boolean | undefined;

	beforeEach(() => {
		savedAptEnabled = setup.apt_update_enabled;
		resetSoftwareUpdateState();
	});

	afterEach(() => {
		setup.apt_update_enabled = savedAptEnabled;
		resetSoftwareUpdateCheckRunner();
		resetSoftwareUpdateSizeRunner();
		resetSoftwareUpdateState();
	});

	test("a completed check stamps a fresh checked_at", async () => {
		setSoftwareUpdateSizeRunner(async () => null);
		let callback: ((err: unknown, failures: number) => unknown) | undefined;
		setSoftwareUpdateCheckRunner((cb) => {
			callback = cb;
			return true;
		});

		const before = getUpdateState();
		expect(before).toEqual({ kind: "idle" });

		expect(triggerManualUpdateCheck()).toBe(true);
		await callback?.(null, 0);

		const after = getUpdateState();
		expect(after.kind).toBe("idle");
		// Pre-fix this was byte-identical to `before`, so a successful check that
		// found nothing was indistinguishable from a dead button.
		expect(after).not.toEqual(before);
		expect(
			after.kind === "idle" ? after.checked_at : undefined,
		).toBeGreaterThan(0);
	});

	test("a REFUSED check never claims to have checked", () => {
		setSoftwareUpdateCheckRunner(() => false);

		expect(triggerManualUpdateCheck()).toBe(false);
		expect(getUpdateState()).toEqual({ kind: "idle" });
	});
});

describe("system.checkForUpdates — a refusal is named, never silent", () => {
	let savedAptEnabled: boolean | undefined;

	beforeEach(() => {
		savedAptEnabled = setup.apt_update_enabled;
	});

	afterEach(() => {
		setup.apt_update_enabled = savedAptEnabled;
		resetSoftwareUpdateCheckRunner();
		resetSoftwareUpdateSizeRunner();
		resetSoftwareUpdateState();
	});

	test("names a device that cannot run the check right now", async () => {
		setSoftwareUpdateCheckRunner(() => false);

		expect(
			await call(checkForUpdatesProcedure, {}, { context: makeContext() }),
		).toEqual({ success: false, error: "check_unavailable" });
	});

	test("names a device with updates turned off", async () => {
		setup.apt_update_enabled = false;

		expect(
			await call(checkForUpdatesProcedure, {}, { context: makeContext() }),
		).toEqual({ success: false, error: "updates_disabled" });
	});
});
