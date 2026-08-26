/**
 * `modems.setUsbMode` — the REAL transition dispatch.
 *
 * The load-bearing property under test is ORDER, not each gate in isolation: a
 * refusal that fires before the transition engine is reached must fire with ZERO
 * engine calls, because the engine serialises behind real hardware and a doomed
 * request must never queue there. Every TIER-A case therefore spy-asserts
 * `createEngine`/`execute` were never invoked — an assertion a comment cannot make.
 *
 * The second property is the lifecycle lease's `finally` release. Todo 23 learned
 * the hard way that a body which always RETURNS never exercises a `finally`, so
 * the release test drives a dependency that THROWS past the dispatch's own error
 * handling rather than an engine that merely fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CERTIFIED_CATALOG,
	type UsbModeTransitionOutcome,
	type UsbModeTransitionRequest,
} from "@ceralive/modem-control";
import { call } from "@orpc/server";

import { getConfig } from "../modules/config.ts";
import {
	defaultMutationJournalFs,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import type { UsbModeDispatchDeps } from "../modules/modems/usb-mode-contract.ts";
import {
	matchCertifiedEntry,
	type ResolvedModemIdentity,
} from "../modules/modems/usb-mode-identity.ts";
import {
	resetUsbModeDispatchDeps,
	runUsbModeTransition,
	setUsbModeDispatchDeps,
} from "../modules/modems/usb-mode-transition.ts";
import {
	isLifecycleHeld,
	resetLifecycleInterlock,
	tryAcquireLifecycle,
} from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { setUsbModeProcedure } from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

// The one SKU the shipped catalog certifies. Every REAL modem is uncertified
// today (no reviewed evidence bundle exists yet), which is why `uncertified` is
// the honest terminal answer on hardware and a first-class rendered state.
const CERTIFIED = {
	vidPid: "2c7c:0125",
	model: "CERALIVE-SYNTHETIC-TEST-SKU",
	firmwareRevision: "SYNTHETICFW01.002.03",
} as const;

function identity(
	overrides: Partial<ResolvedModemIdentity> = {},
): ResolvedModemIdentity {
	return {
		stableKey: "platform-xhci-hcd.0-usb-1:2",
		vidPid: CERTIFIED.vidPid,
		model: CERTIFIED.model,
		firmwareRevision: CERTIFIED.firmwareRevision,
		currentMode: "qmi",
		physicalUid: "platform-xhci-hcd.0-usb-1:2",
		ifname: "wwan0",
		ports: ["wwan0 (net)", "ttyUSB2 (at)"],
		...overrides,
	};
}

interface Spy {
	engineBuilds: number;
	executions: UsbModeTransitionRequest[];
	rediscoveries: number;
}

const SUCCEEDED: UsbModeTransitionOutcome = {
	status: "succeeded",
	newIfname: "wwan0" as UsbModeTransitionRequest["deviceIfname"],
	steps: [],
};

/**
 * Build the dispatch deps AND install them as the module's active set, so the
 * same fixture serves a direct `runUsbModeTransition` call and a drive through
 * the REAL procedure (which reads the active set).
 */
function deps(
	overrides: Partial<UsbModeDispatchDeps> = {},
	outcome: UsbModeTransitionOutcome = SUCCEEDED,
): { deps: UsbModeDispatchDeps; spy: Spy } {
	const spy: Spy = { engineBuilds: 0, executions: [], rediscoveries: 0 };
	const built: UsbModeDispatchDeps = {
		resolveIdentity: () => Promise.resolve(identity()),
		catalog: CERTIFIED_CATALOG,
		resolveConnectionId: () => Promise.resolve("uuid-1"),
		resolveInhibitUid: () => Promise.resolve("uid-1"),
		createEngine: () => {
			spy.engineBuilds += 1;
			return {
				execute: (request: UsbModeTransitionRequest) => {
					spy.executions.push(request);
					return Promise.resolve(outcome);
				},
			};
		},
		// The armed rollback is cancelled only once the link is confirmed back. The
		// production default polls the REAL nmcli for 90 s, so a harness that
		// omitted it would turn every success case into a data-path timeout.
		confirmDataPath: () => Promise.resolve(true),
		rediscover: () => {
			spy.rediscoveries += 1;
			return Promise.resolve();
		},
		now: () => 1_700_000_000_000,
		...overrides,
	};
	setUsbModeDispatchDeps(built);
	return { deps: built, spy };
}

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

const REQUEST = { device: "0", mode: "mbim", confirm: true } as const;

// A connectivity-losing mutation now ARMS a durable journal entry before it
// dispatches, so the dispatch needs somewhere it can actually write: the pinned
// device location is `/data`, which no test host has. A journal that cannot
// commit refuses the mutation outright (fail-closed), which would mask every
// gate assertion below it.
let journalDir: string;

beforeEach(async () => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetUsbModeDispatchDeps();
	journalDir = await mkdtemp(join(tmpdir(), "ceraui-usb-mode-transition-"));
	setMutationJournalDeps({
		fs: defaultMutationJournalFs,
		dir: journalDir,
		now: () => 1_700_000_000_000,
	});
});

afterEach(async () => {
	resetLifecycleInterlock();
	resetRecoveryBarrier();
	resetUsbModeDispatchDeps();
	resetMutationJournalDeps();
	delete getConfig().modem_provisioning;
	updateStatus(false);
	await rm(journalDir, { recursive: true, force: true });
});

function provisioned(): void {
	getConfig().modem_provisioning = true;
}

describe("TIER A — an entry refusal fires ZERO engine calls", () => {
	test("an unprovisioned device never reaches the engine", async () => {
		const { spy } = deps();

		await withDeviceType("real", async () => {
			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({ success: false, error: "provisioning_disabled" });
		});

		expect(spy.engineBuilds).toBe(0);
		expect(spy.executions).toHaveLength(0);
	});

	test("an emulated host never reaches the engine", async () => {
		const { spy } = deps();

		await withDeviceType("emulated", async () => {
			provisioned();
			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({ success: false, error: "unavailable_in_emulated_mode" });
		});

		expect(spy.engineBuilds).toBe(0);
	});

	test("a LIVE stream never reaches the engine", async () => {
		const { spy } = deps();

		await withDeviceType("real", async () => {
			provisioned();
			updateStatus(true);
			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({ success: false, error: "streaming_active" });
		});

		expect(spy.engineBuilds).toBe(0);
	});

	test("an ADMITTED-but-not-yet-live start never reaches the engine — the window `getIsStreaming()` cannot see", async () => {
		const { spy } = deps();
		const admission = tryAcquireLifecycle("streaming");
		expect(admission.admitted).toBe(true);

		await withDeviceType("real", async () => {
			provisioned();
			// `getIsStreaming()` is still FALSE here — the interlock is the only
			// thing that can refuse this, which is the whole reason it exists.
			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({ success: false, error: "streaming_active" });
		});

		expect(spy.engineBuilds).toBe(0);
	});

	test("a concurrent modem transition is its OWN refusal, not a stream one", async () => {
		const { spy } = deps();
		tryAcquireLifecycle("modem-transition");

		await withDeviceType("real", async () => {
			provisioned();
			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({ success: false, error: "transition_in_progress" });
		});

		expect(spy.engineBuilds).toBe(0);
	});
});

describe("TIER A — the catalog gate also fires before the engine", () => {
	test("an unidentifiable device refuses typed, with no engine call", async () => {
		const { deps: d, spy } = deps({
			resolveIdentity: () => Promise.resolve(undefined),
		});

		expect(await runUsbModeTransition("0", "mbim", d)).toEqual({
			success: false,
			error: "transition_failed",
			reason: "identity_unresolved",
		});
		expect(spy.engineBuilds).toBe(0);
	});

	test("a NON-MM target crosses the MM↔router line the catalog forbids", async () => {
		const { deps: d, spy } = deps();

		expect(await runUsbModeTransition("0", "rndis", d)).toEqual({
			success: false,
			error: "uncertified",
		});
		expect(await runUsbModeTransition("0", "router-ethernet", d)).toEqual({
			success: false,
			error: "uncertified",
		});
		expect(spy.engineBuilds).toBe(0);
	});

	test("an uncertified SKU refuses — the honest answer for EVERY real modem today", async () => {
		const { deps: d, spy } = deps({
			resolveIdentity: () =>
				Promise.resolve(identity({ vidPid: "2c7c:0801", model: "RM520N-GL" })),
		});

		expect(await runUsbModeTransition("0", "mbim", d)).toEqual({
			success: false,
			error: "uncertified",
		});
		expect(spy.engineBuilds).toBe(0);
	});

	test("a certified SKU on an UNPERMITTED transition still refuses", async () => {
		const { deps: d, spy } = deps({
			resolveIdentity: () => Promise.resolve(identity({ currentMode: "mbim" })),
		});

		// mbim→ecm-ncm is absent from the entry's permittedTransitions.
		expect(await runUsbModeTransition("0", "ecm-ncm", d)).toEqual({
			success: false,
			error: "uncertified",
		});
		expect(spy.engineBuilds).toBe(0);
	});

	test("a device ALREADY in the target mode succeeds without touching anything", async () => {
		const { deps: d, spy } = deps({
			resolveIdentity: () => Promise.resolve(identity({ currentMode: "mbim" })),
		});

		expect(await runUsbModeTransition("0", "mbim", d)).toEqual({
			success: true,
		});
		expect(spy.engineBuilds).toBe(0);
		expect(spy.rediscoveries).toBe(0);
	});

	test("the firmware discriminator matches a PREFIX, not a truncation", async () => {
		const catalog = {
			schemaVersion: 1 as const,
			entries: [
				{
					vidPid: CERTIFIED.vidPid,
					model: CERTIFIED.model,
					firmwarePrefix: "SYNTHETICFW01",
					canonicalMode: "qmi" as const,
					permittedTransitions: [],
				},
			],
		};

		expect(
			matchCertifiedEntry(catalog, {
				vidPid: CERTIFIED.vidPid,
				model: CERTIFIED.model,
				firmwareRevision: "SYNTHETICFW01.002.03",
			}),
		).toBeDefined();
		// A different firmware family on the same VID:PID+model is NOT this entry.
		expect(
			matchCertifiedEntry(catalog, {
				vidPid: CERTIFIED.vidPid,
				model: CERTIFIED.model,
				firmwareRevision: "SYNTHETICFW02.000.01",
			}),
		).toBeUndefined();
		// An empty revision must never match an entry by vacuous prefix.
		expect(
			matchCertifiedEntry(catalog, {
				vidPid: CERTIFIED.vidPid,
				model: CERTIFIED.model,
				firmwareRevision: "",
			}),
		).toBeUndefined();
	});
});

describe("TIER B/C — past the catalog, the engine decides", () => {
	test("no wired engine is reported as itself, never as a fake success", async () => {
		const { deps: d } = deps({ createEngine: () => undefined });

		expect(await runUsbModeTransition("0", "mbim", d)).toEqual({
			success: false,
			error: "transition_failed",
			reason: "engine_unavailable",
		});
	});

	test("a verified success triggers EXACTLY ONE re-discovery + broadcast", async () => {
		const { deps: d, spy } = deps();

		expect(await runUsbModeTransition("0", "mbim", d)).toEqual({
			success: true,
		});
		expect(spy.executions).toHaveLength(1);
		// Not zero (the 30 s poll would land after any reasonable UI bound) and
		// not a loop.
		expect(spy.rediscoveries).toBe(1);
	});

	test("the request carries the stable key and the MATCHED catalog SKU", async () => {
		const { deps: d, spy } = deps();

		await runUsbModeTransition("0", "mbim", d);
		const request = spy.executions[0];
		expect(request?.stableKey).toBe("platform-xhci-hcd.0-usb-1:2");
		expect(request?.sku.firmwarePrefix).toBe("SYNTHETICFW01");
		expect(request?.fromMode).toBe("qmi");
		expect(request?.toMode).toBe("mbim");
		expect(request?.confirm).toBe(true);
		expect(request?.maintenance).toBe(true);
	});

	test("a POSTCONDITION mismatch is distinguished from a mid-flight fault", async () => {
		const { deps: d } = deps(
			{},
			{
				status: "failed",
				degraded: true,
				reason: "postcondition mismatch: observed qmi vs target mbim",
				steps: ["nm-quiesce", "at-command", "postcondition"],
			},
		);

		expect(await runUsbModeTransition("0", "mbim", d)).toEqual({
			success: false,
			error: "transition_failed",
			reason: "postcondition_mismatch",
		});
	});

	test("a fault BEFORE the postcondition is a transaction error", async () => {
		const { deps: d } = deps(
			{},
			{
				status: "failed",
				degraded: true,
				reason: "control port did not drop within 60000ms",
				steps: ["nm-quiesce", "inhibit", "at-command", "await-port-drop"],
			},
		);

		expect(await runUsbModeTransition("0", "mbim", d)).toEqual({
			success: false,
			error: "transition_failed",
			reason: "transaction_error",
		});
	});

	test("the engine's own precondition re-check maps to its own reason", async () => {
		const { deps: d } = deps(
			{},
			{
				status: "refused",
				stage: "in-actor",
				reason: "interlock held: streaming",
				steps: ["actor-enter"],
			},
		);

		expect(await runUsbModeTransition("0", "mbim", d)).toEqual({
			success: false,
			error: "transition_failed",
			reason: "preconditions_refused",
		});
	});

	test("a THROWING engine never reports success, and never re-discovers", async () => {
		const { deps: d, spy } = deps({
			createEngine: () => ({
				execute: () => Promise.reject(new Error("socket closed")),
			}),
		});

		expect(await runUsbModeTransition("0", "mbim", d)).toEqual({
			success: false,
			error: "transition_failed",
			reason: "transaction_error",
		});
		expect(spy.rediscoveries).toBe(0);
	});

	test("a failed transition never re-discovers", async () => {
		const { deps: d, spy } = deps(
			{},
			{
				status: "failed",
				degraded: true,
				reason: "nope",
				steps: ["postcondition"],
			},
		);

		await runUsbModeTransition("0", "mbim", d);
		expect(spy.rediscoveries).toBe(0);
	});
});

describe("the lifecycle lease is released on EVERY exit", () => {
	test("a successful transition releases it", async () => {
		deps();

		await withDeviceType("real", async () => {
			provisioned();
			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({ success: true });
		});

		expect(isLifecycleHeld()).toBe(false);
	});

	test("a dependency that THROWS PAST the dispatch's own handling still releases it", async () => {
		// Deliberately NOT a failing engine: the dispatch catches those and returns
		// normally, so such a fixture would prove only the ordinary return path.
		// `resolveIdentity` is uncaught inside `runUsbModeTransition`, so this throw
		// genuinely escapes into `withLifecycleLock`'s `finally`.
		deps({
			resolveIdentity: () => {
				throw new Error("udev enumeration blew up");
			},
		});

		await withDeviceType("real", async () => {
			provisioned();
			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({
				success: false,
				error: "transition_failed",
				reason: "transaction_error",
				// `transaction_error` says only that the transaction blew up. The
				// classified outcome rides beside it so an operator learns whether the
				// daemon refused or something unplaceable did — here, a bare Error, so
				// the package's own fallback arm.
				operation: {
					status: "refused",
					completion: "failed",
					reason: "failed",
					refusal: "failed",
					retryable: false,
				},
			});
		});

		expect(isLifecycleHeld()).toBe(false);
	});

	test("and the next transition is therefore admitted", async () => {
		deps({
			resolveIdentity: () => {
				throw new Error("udev enumeration blew up");
			},
		});

		await withDeviceType("real", async () => {
			provisioned();
			await call(setUsbModeProcedure, REQUEST, { context: makeContext() });
		});

		deps();
		await withDeviceType("real", async () => {
			provisioned();
			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({ success: true });
		});
	});
});
