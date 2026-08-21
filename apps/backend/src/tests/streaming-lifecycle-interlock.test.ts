/**
 * LifecycleInterlock — the streaming-admission ↔ modem-lifecycle mutual
 * exclusion, proven in BOTH race orders plus the no-deadlock guarantee.
 *
 * The `"modem-transition"` side is driven by TEST-ONLY callers here: wiring it
 * into the real USB-mode-switch flow is the next todo's job, and this suite
 * proves the primitive and its streaming-side integration ahead of it.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";

import { call } from "@orpc/server";
import {
	initMockService,
	resetMockState,
	setStreamingState,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	currentLifecycleHolder,
	isLifecycleHeld,
	type LifecycleAdmission,
	type LifecycleLease,
	leaseRefusal,
	MODEM_TRANSITION_ACTIVE,
	resetLifecycleInterlock,
	STREAMING_ACTIVE,
	tryAcquireLifecycle,
	withLifecycleLock,
} from "../modules/streaming/lifecycle-admission.ts";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { streamingStartProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

async function settleMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function attemptIds(): () => string {
	let next = 0;
	return () => `attempt-${++next}`;
}

function expectAdmitted(admission: LifecycleAdmission): LifecycleLease {
	if (!admission.admitted) {
		throw new Error(
			`expected admission, got a refusal from ${admission.heldBy}`,
		);
	}
	return admission.lease;
}

function interlockedOrchestrator(
	overrides: Partial<
		Parameters<typeof createStreamSessionOrchestrator>[0]
	> = {},
) {
	return createStreamSessionOrchestrator({
		createAttemptId: attemptIds(),
		setStreamingStatus: () => {},
		stopRuntime: async () => {},
		queryRuntime: async () => "idle",
		admitLifecycle: () => tryAcquireLifecycle("streaming"),
		...overrides,
	});
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

describe("lifecycle interlock — the primitive", () => {
	beforeEach(() => resetLifecycleInterlock());
	afterEach(() => resetLifecycleInterlock());

	test("one refusal table serves both directions", () => {
		expect(leaseRefusal("streaming")).toBe(STREAMING_ACTIVE);
		expect(leaseRefusal("modem-transition")).toBe(MODEM_TRANSITION_ACTIVE);
		expect(MODEM_TRANSITION_ACTIVE).toBe("MODEM_TRANSITION_ACTIVE");
		// The SAME token `modems.setUsbMode` already answers for a LIVE stream, so
		// the admission window and the running stream refuse identically.
		expect(STREAMING_ACTIVE).toBe("streaming_active");
	});

	test("a held interlock refuses the other holder and names who holds it", () => {
		const lease = expectAdmitted(tryAcquireLifecycle("streaming"));

		expect(tryAcquireLifecycle("modem-transition")).toEqual({
			admitted: false,
			heldBy: "streaming",
			refusal: STREAMING_ACTIVE,
		});
		expect(currentLifecycleHolder()).toBe("streaming");

		lease.release();
		expect(isLifecycleHeld()).toBe(false);
		expectAdmitted(tryAcquireLifecycle("modem-transition")).release();
	});

	test("the exclusion is symmetric — a transition refuses an admission", () => {
		const lease = expectAdmitted(tryAcquireLifecycle("modem-transition"));

		expect(tryAcquireLifecycle("streaming")).toEqual({
			admitted: false,
			heldBy: "modem-transition",
			refusal: MODEM_TRANSITION_ACTIVE,
		});

		lease.release();
		expectAdmitted(tryAcquireLifecycle("streaming")).release();
	});

	test("release is idempotent, and a stale release never frees a later holder", () => {
		const stale = expectAdmitted(tryAcquireLifecycle("streaming"));
		stale.release();
		stale.release();
		expect(isLifecycleHeld()).toBe(false);

		const later = expectAdmitted(tryAcquireLifecycle("modem-transition"));
		stale.release();
		expect(currentLifecycleHolder()).toBe("modem-transition");
		later.release();
		expect(isLifecycleHeld()).toBe(false);
	});

	test("withLifecycleLock releases under a THROW, so the next acquire succeeds", async () => {
		let caught: unknown;
		try {
			await withLifecycleLock("streaming", async () => {
				throw new Error("engine start blew up after admission");
			});
		} catch (error) {
			caught = error;
		}

		expect((caught as Error | undefined)?.message).toBe(
			"engine start blew up after admission",
		);
		expect(isLifecycleHeld()).toBe(false);
		expectAdmitted(tryAcquireLifecycle("modem-transition")).release();
	});

	test("withLifecycleLock refuses WITHOUT running the guarded operation", async () => {
		const held = expectAdmitted(tryAcquireLifecycle("streaming"));
		let ran = false;

		const outcome = await withLifecycleLock("modem-transition", async () => {
			ran = true;
			return "never";
		});

		expect(outcome).toEqual({ acquired: false, refusal: STREAMING_ACTIVE });
		expect(ran).toBe(false);
		held.release();
	});
});

describe("lifecycle interlock — streaming admission (both race orders)", () => {
	beforeEach(() => resetLifecycleInterlock());
	afterEach(() => resetLifecycleInterlock());

	test("race order A: a start attempted DURING a modem transition is refused, and never launches", async () => {
		const transition = expectAdmitted(tryAcquireLifecycle("modem-transition"));
		const orchestrator = interlockedOrchestrator();
		let launches = 0;

		const result = await orchestrator.start({
			origin: "ui",
			launch: async () => {
				launches += 1;
			},
		});

		expect(launches).toBe(0);
		// The class is `modem_transition_active`, NOT the generic `start_invalid`:
		// the frontend renders `live.startFailure.class.<class>`, so the generic
		// class would tell an operator whose modem is merely re-enumerating to
		// "check your settings" — wrong advice for a bounded, self-clearing race.
		expect(result).toEqual({
			result: "failed",
			attemptId: "attempt-1",
			failure: {
				attemptId: "attempt-1",
				phase: "params",
				class: "modem_transition_active",
				code: MODEM_TRANSITION_ACTIVE,
				retriable: false,
			},
		});
		expect(orchestrator.snapshot().state).toBe("idle");
		expect(currentLifecycleHolder()).toBe("modem-transition");

		transition.release();
	});

	test("race order B: a transition attempted DURING an admitted start is refused until it settles", async () => {
		const orchestrator = interlockedOrchestrator();
		const launched = deferred();
		const releaseLaunch = deferred();

		const starting = orchestrator.start({
			origin: "ui",
			launch: async () => {
				launched.resolve();
				await releaseLaunch.promise;
			},
		});
		await launched.promise;
		await settleMicrotasks();

		expect(currentLifecycleHolder()).toBe("streaming");
		expect(tryAcquireLifecycle("modem-transition")).toEqual({
			admitted: false,
			heldBy: "streaming",
			refusal: STREAMING_ACTIVE,
		});

		releaseLaunch.resolve();
		expect(await starting).toEqual({
			result: "started",
			attemptId: "attempt-1",
		});

		expect(isLifecycleHeld()).toBe(false);
		expectAdmitted(tryAcquireLifecycle("modem-transition")).release();
	});

	test("the interlock sits AFTER the duplicate-start rejection — a duplicate keeps its own busy answer", async () => {
		const orchestrator = interlockedOrchestrator();
		const launched = deferred();
		const releaseLaunch = deferred();

		const first = orchestrator.start({
			origin: "ui",
			launch: async () => {
				launched.resolve();
				await releaseLaunch.promise;
			},
		});
		await launched.promise;
		await settleMicrotasks();

		// The lease IS held by this orchestrator's own admission, so an acquire
		// placed ahead of the duplicate check would answer `streaming_active` here.
		const duplicate = await orchestrator.start({
			origin: "ui",
			launch: async () => {
				throw new Error("a duplicate start must never launch");
			},
		});
		expect(duplicate).toEqual({ result: "busy", attemptId: "attempt-2" });

		releaseLaunch.resolve();
		await first;
	});

	// A throwing LAUNCH is caught by the retry runner and returned as a typed
	// `failed`, so it exercises the ordinary return path — not the `finally`.
	test("a launch that fails still releases the lease — the next start is admitted", async () => {
		const orchestrator = interlockedOrchestrator();

		const failed = await orchestrator.start({
			origin: "ui",
			launch: async () => {
				throw new Error("engine start blew up after admission");
			},
		});

		expect(failed.result).toBe("failed");
		expect(isLifecycleHeld()).toBe(false);

		let launches = 0;
		const next = await orchestrator.start({
			origin: "ui",
			launch: async () => {
				launches += 1;
			},
		});
		expect(next.result).toBe("started");
		expect(launches).toBe(1);
		expect(isLifecycleHeld()).toBe(false);
	});

	test("an admission that THROWS mid-flight still releases the lease (finally, not the return path)", async () => {
		const orchestrator = interlockedOrchestrator({
			setStreamingStatus: (streaming) => {
				if (streaming) throw new Error("bookkeeping blew up mid-admission");
			},
		});

		await expect(
			orchestrator.start({ origin: "ui", launch: async () => {} }),
		).rejects.toThrow("bookkeeping blew up mid-admission");

		expect(isLifecycleHeld()).toBe(false);
		expectAdmitted(tryAcquireLifecycle("modem-transition")).release();
	});

	test("an orchestrator with no interlock dep never touches the process-wide lease", async () => {
		const orchestrator = createStreamSessionOrchestrator({
			createAttemptId: attemptIds(),
			setStreamingStatus: () => {},
			stopRuntime: async () => {},
			queryRuntime: async () => "idle",
		});
		const transition = expectAdmitted(tryAcquireLifecycle("modem-transition"));

		const result = await orchestrator.start({
			origin: "ui",
			launch: async () => {},
		});

		expect(result.result).toBe("started");
		expect(currentLifecycleHolder()).toBe("modem-transition");
		transition.release();
	});
});

describe("lifecycle interlock — the production streaming.start wiring", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
	});
	beforeEach(() => {
		resetLifecycleInterlock();
		setStreamingState(false);
		updateStatus(false);
	});
	afterEach(() => {
		resetLifecycleInterlock();
		setStreamingState(false);
		updateStatus(false);
		resetMockState();
	});
	afterAll(() => {
		stopMockService();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("the real streaming.start is refused with MODEM_TRANSITION_ACTIVE while a transition holds the lease", async () => {
		const transition = expectAdmitted(tryAcquireLifecycle("modem-transition"));
		try {
			const result = await call(
				streamingStartProcedure,
				{},
				{ context: makeContext() },
			);

			expect(result).toMatchObject({
				success: false,
				is_streaming: false,
				error: MODEM_TRANSITION_ACTIVE,
			});
		} finally {
			transition.release();
		}
	});

	// The release path is deliberately NOT driven through the real procedure: an
	// admitted start arms the restoration marker and leaves the production
	// orchestrator `streaming`, which would leak state into every later suite in
	// the same `bun test` process. It is proven against the orchestrator above.
	test("the refusal costs the production orchestrator nothing — the next start is admitted", async () => {
		const transition = expectAdmitted(tryAcquireLifecycle("modem-transition"));
		await call(streamingStartProcedure, {}, { context: makeContext() });
		transition.release();

		expect(isLifecycleHeld()).toBe(false);
		expectAdmitted(tryAcquireLifecycle("streaming")).release();
	});
});
