/**
 * `modem.reconfig` on the self_fencing route — preservation + the init-window gate.
 *
 * Two things are pinned here, both easy to break from the cellular side:
 *
 *   1. PRESERVATION. Introducing the cellular stack must not shift a single wire
 *      semantic of REQ-RRS-008/010/011/012/014: the top-level `self_fencing` flag,
 *      snapshot-before-mutation, the 30s watchdog with automatic revert, commit only
 *      on a cid-matching payload-less confirm, truthful `ok`/`applied`/`reverted`, and
 *      exactly one delivery-ack per received frame with cid de-dup. Every one of these
 *      runs under BOTH backend selections, because "it still works on mmcli" is not
 *      evidence that it works on the backend the flag actually switches to.
 *
 *   2. THE GATE. While the stack is initializing the op is refused BEFORE it mutates
 *      anything — no snapshot, no apply, no armed watchdog — behind the delivery-ack
 *      the router already sent. A half-applied modem reconfig with a live watchdog is
 *      exactly the brick risk self_fencing exists to prevent.
 *
 * Commands are driven through `routeCommand`, not `handleSelfFencingOp` directly, so
 * the ack → de-dup → self_fencing-branch ordering is part of what is asserted. A
 * dispatch table that throws proves the op never falls through to `deps.dispatch`.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
	CELLULAR_STACK_INITIALIZING,
	type CellularStartResult,
	getCellularStack,
	initCellularStack,
	type ModemBackendKind,
	resetCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import { getConfig } from "../modules/config.ts";
import {
	createSeenCidStore,
	resetSharedSeenCidStore,
} from "../modules/remote-control/command-idempotency.ts";
import {
	type CommandRouterDeps,
	routeCommand,
} from "../modules/remote-control/command-router.ts";
import {
	type Command,
	type DeliveryAck,
	type Result,
	SELF_FENCING_TYPES,
	SELF_FENCING_WATCHDOG_MS,
	tolerantParseCommand,
} from "../modules/remote-control/protocol.ts";
import {
	type NonRevertibleOp,
	type RevertibleOp,
	resetSelfFencingState,
	SELF_FENCING_NOT_READY_ERROR,
	type SelfFencingDeps,
	type SelfFencingOps,
} from "../modules/remote-control/self-fencing.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";

const CID_APPLY = "7a1c0f10-0000-4000-8000-000000000001";
const CID_REVERT = "7a1c0f10-0000-4000-8000-000000000002";
const CID_CONFIRM = "7a1c0f10-0000-4000-8000-000000000003";
const CID_RETRY = "7a1c0f10-0000-4000-8000-000000000004";
const CID_OTHER = "7a1c0f10-0000-4000-8000-000000000005";
const CID_INIT = "7a1c0f10-0000-4000-8000-000000000006";
const CID_AFTER = "7a1c0f10-0000-4000-8000-000000000007";

const BACKENDS: readonly ModemBackendKind[] = ["mmcli", "dbus"];

interface ModemConfigState {
	apn: string;
	roaming: boolean;
	slot: number;
	bands: number[];
}

const INITIAL_STATE: ModemConfigState = {
	apn: "internet",
	roaming: false,
	slot: 1,
	bands: [3, 7, 20],
};

interface FakeTimer {
	fn: () => void;
	ms: number;
	cleared: boolean;
}

interface FakeClock {
	timers: FakeTimer[];
	armed: () => FakeTimer[];
	setTimer: SelfFencingDeps["setTimer"];
	clearTimer: SelfFencingDeps["clearTimer"];
	fire: () => Promise<void>;
}

/** A real macrotask tick so the void-detached watchdog continuation settles. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeClock(): FakeClock {
	const timers: FakeTimer[] = [];
	return {
		timers,
		armed: () => timers.filter((timer) => !timer.cleared),
		setTimer: (fn, ms) => {
			const timer: FakeTimer = { fn, ms, cleared: false };
			timers.push(timer);
			return timer as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (handle) => {
			(handle as unknown as FakeTimer).cleared = true;
		},
		fire: async () => {
			for (const timer of timers) {
				if (!timer.cleared) timer.fn();
			}
			await flush();
		},
	};
}

interface OpCalls {
	order: string[];
	snapshot: number;
	apply: number;
	revert: number;
}

/**
 * A revertible op over REAL mutable state (not a canned return), so the revert
 * assertion can compare the post-revert object against a pre-mutation serialization
 * rather than merely counting a call.
 */
function modemStateOp(box: { state: ModemConfigState }): {
	op: RevertibleOp;
	calls: OpCalls;
} {
	const calls: OpCalls = { order: [], snapshot: 0, apply: 0, revert: 0 };
	const op: RevertibleOp = {
		revertible: true,
		snapshot: async () => {
			calls.snapshot += 1;
			calls.order.push("snapshot");
			return structuredClone(box.state);
		},
		apply: async (payload) => {
			calls.apply += 1;
			calls.order.push("apply");
			box.state = {
				...box.state,
				...(payload as Partial<ModemConfigState> | undefined),
			};
			return structuredClone(box.state);
		},
		revert: async (snapshot) => {
			calls.revert += 1;
			calls.order.push("revert");
			box.state = structuredClone(snapshot as ModemConfigState);
		},
	};
	return { op, calls };
}

/** Fill the op table with a throwing default, then overlay the op under test. */
function makeOps(op: RevertibleOp): SelfFencingOps {
	const unexpected: NonRevertibleOp = {
		revertible: false,
		execute: async () => {
			throw new Error("unexpected op invocation");
		},
	};
	return {
		"network.reconfig": unexpected,
		"modem.reconfig": op,
		"device.remoteKeyChange": unexpected,
		"system.reboot": unexpected,
		"device.factoryReset": unexpected,
	};
}

function makeCommand(overrides: Partial<Command> = {}): Command {
	return {
		v: 1,
		kind: "command",
		type: "modem.reconfig",
		cid: CID_APPLY,
		role: "owner",
		self_fencing: true,
		payload: { apn: "iot.example", roaming: true },
		...overrides,
	};
}

function makeConfirm(cid: string): Command {
	return {
		v: 1,
		kind: "command",
		type: "self_fencing.confirm",
		cid,
		role: "owner",
	};
}

interface Harness {
	results: Result[];
	acks: DeliveryAck[];
	clock: FakeClock;
	calls: OpCalls;
	box: { state: ModemConfigState };
	dispatchedCount: () => number;
	deps: Partial<CommandRouterDeps>;
}

function harness(): Harness {
	const results: Result[] = [];
	const acks: DeliveryAck[] = [];
	const clock = fakeClock();
	const box = { state: structuredClone(INITIAL_STATE) };
	const { op, calls } = modemStateOp(box);
	let dispatched = 0;

	return {
		results,
		acks,
		clock,
		calls,
		box,
		dispatchedCount: () => dispatched,
		deps: {
			sendResult: (frame: Result) => {
				results.push(frame);
				return true;
			},
			sendDeliveryAck: (frame: DeliveryAck) => {
				acks.push(frame);
				return true;
			},
			seenCids: createSeenCidStore(),
			// A self_fencing op that reaches procedure dispatch has bypassed the
			// watchdog entirely — this table makes that failure loud, not silent.
			dispatch: {
				"modem.reconfig": async () => {
					dispatched += 1;
					throw new Error("modem.reconfig must never reach procedure dispatch");
				},
			},
			selfFencing: {
				ops: makeOps(op),
				watchdogMs: SELF_FENCING_WATCHDOG_MS,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
				logger: { info: () => {}, warn: () => {} },
			},
		},
	};
}

let releaseInit: ((value: CellularStartResult) => void) | undefined;

function resetStack(): void {
	releaseInit?.({ ok: true });
	releaseInit = undefined;
	resetCellularStack();
	resetBootReadiness();
	delete getConfig().modem_backend;
}

/** Bring the stack to READY under the named backend, via the real init path. */
async function readyUnder(backend: ModemBackendKind): Promise<void> {
	resetStack();
	if (backend === "mmcli") {
		await initCellularStack({ backend: "mmcli" });
		return;
	}
	await initCellularStack({
		backend: "dbus",
		createDbusBackend: () => ({
			start: async () => ({ ok: true }),
			stop: async (): Promise<void> => undefined,
		}),
	});
}

/** Hold the dbus backend before its first authoritative snapshot — the init window. */
function enterInitializing(): void {
	resetStack();
	const gate = new Promise<CellularStartResult>((resolve) => {
		releaseInit = resolve;
	});
	void initCellularStack({
		backend: "dbus",
		createDbusBackend: () => ({
			start: () => gate,
			stop: async (): Promise<void> => undefined,
		}),
	});
}

afterEach(() => {
	resetSelfFencingState();
	resetSharedSeenCidStore();
	resetStack();
});

describe("modem.reconfig wire classification (REQ-RRS-008)", () => {
	test("is a self_fencing op carrying the top-level flag", () => {
		expect(SELF_FENCING_TYPES).toContain("modem.reconfig");

		const parsed = tolerantParseCommand({
			v: 1,
			kind: "command",
			type: "modem.reconfig",
			cid: CID_APPLY,
			role: "owner",
			self_fencing: true,
			payload: { apn: "iot.example" },
		});

		expect(parsed.self_fencing).toBe(true);
	});

	test("the watchdog default is 30s on both sides (REQ-RRS-012)", () => {
		expect(SELF_FENCING_WATCHDOG_MS).toBe(30_000);
	});
});

for (const backend of BACKENDS) {
	describe(`modem.reconfig self_fencing preservation — ${backend} backend`, () => {
		test("snapshots before mutating and arms the 30s watchdog", async () => {
			await readyUnder(backend);
			expect(getCellularStack().backend).toBe(backend);
			expect(getCellularStack().ready).toBe(true);

			const h = harness();
			await routeCommand(makeCommand({ cid: CID_APPLY }), h.deps);

			expect(h.calls.order).toEqual(["snapshot", "apply"]);
			expect(h.dispatchedCount()).toBe(0);

			expect(h.acks).toHaveLength(1);
			expect(h.acks[0]?.kind).toBe("delivery.ack");
			expect(h.acks[0]?.type).toBe("modem.reconfig");
			expect(h.acks[0]?.cid).toBe(CID_APPLY);
			expect(h.acks[0]).not.toHaveProperty("payload");

			expect(h.results).toHaveLength(1);
			expect(h.results[0]?.cid).toBe(CID_APPLY);
			expect(h.results[0]?.self_fencing).toBe(true);
			expect(h.results[0]?.payload).toEqual({
				ok: true,
				applied: { ...INITIAL_STATE, apn: "iot.example", roaming: true },
			});

			expect(h.clock.armed()).toHaveLength(1);
			expect(h.clock.armed()[0]?.ms).toBe(30_000);
		});

		test("an unconfirmed watchdog reverts the snapshot byte-identically", async () => {
			await readyUnder(backend);

			const h = harness();
			const before = JSON.stringify(h.box.state);

			await routeCommand(makeCommand({ cid: CID_REVERT }), h.deps);
			expect(JSON.stringify(h.box.state)).not.toBe(before);

			await h.clock.fire();

			expect(h.calls.revert).toBe(1);
			expect(JSON.stringify(h.box.state)).toBe(before);
			expect(h.box.state).toEqual(INITIAL_STATE);

			expect(h.results).toHaveLength(2);
			expect(h.results[1]?.payload).toEqual({
				ok: true,
				applied: INITIAL_STATE,
				reverted: true,
			});
		});

		test("commits only on a cid-matching, payload-less confirm", async () => {
			await readyUnder(backend);

			const h = harness();
			await routeCommand(makeCommand({ cid: CID_CONFIRM }), h.deps);
			const applied = structuredClone(h.box.state);

			// A confirm for a different cid resolves nothing — the op stays pending.
			await routeCommand(makeConfirm(CID_OTHER), h.deps);
			expect(h.results).toHaveLength(1);
			expect(h.clock.armed()).toHaveLength(1);

			const confirm = makeConfirm(CID_CONFIRM);
			expect(confirm.payload).toBeUndefined();
			await routeCommand(confirm, h.deps);

			expect(h.calls.revert).toBe(0);
			expect(h.clock.armed()).toHaveLength(0);
			expect(h.results).toHaveLength(2);
			expect(h.results[1]?.payload).toEqual({
				ok: true,
				applied,
				reverted: false,
			});

			// The cancelled watchdog is inert; the committed state stands.
			await h.clock.fire();
			expect(h.calls.revert).toBe(0);
			expect(h.results).toHaveLength(2);
			expect(h.box.state).toEqual(applied);
		});

		test("a duplicate-cid retry is re-acked but executes zero mutations", async () => {
			await readyUnder(backend);

			const h = harness();
			const frame = makeCommand({ cid: CID_RETRY });

			await routeCommand(frame, h.deps);
			const afterFirst = structuredClone(h.box.state);

			await routeCommand(frame, h.deps);

			expect(h.acks).toHaveLength(2);
			expect(h.calls.snapshot).toBe(1);
			expect(h.calls.apply).toBe(1);
			expect(h.calls.revert).toBe(0);
			expect(h.box.state).toEqual(afterFirst);
			expect(h.results).toHaveLength(1);
			expect(h.clock.timers).toHaveLength(1);
		});

		test("a ready stack never emits the init-window refusal", async () => {
			await readyUnder(backend);

			const h = harness();
			await routeCommand(makeCommand({ cid: CID_APPLY }), h.deps);

			expect(h.results[0]?.payload).not.toHaveProperty(
				"error",
				SELF_FENCING_NOT_READY_ERROR,
			);
			expect(h.results[0]?.payload.ok).toBe(true);
		});
	});
}

describe("modem.reconfig readiness gate (annex CELLULAR_STACK_INITIALIZING)", () => {
	test("refuses in the init window without snapshotting, applying, or arming", async () => {
		enterInitializing();
		expect(getCellularStack().ready).toBe(false);

		const h = harness();
		const before = JSON.stringify(h.box.state);

		await routeCommand(makeCommand({ cid: CID_INIT }), h.deps);

		// The ack still goes out — a refusal is a truthful answer, never a drop.
		expect(h.acks).toHaveLength(1);
		expect(h.acks[0]?.cid).toBe(CID_INIT);

		expect(h.results).toHaveLength(1);
		expect(h.results[0]?.cid).toBe(CID_INIT);
		expect(h.results[0]?.payload).toEqual({
			ok: false,
			applied: null,
			error: SELF_FENCING_NOT_READY_ERROR,
		});
		expect(h.results[0]?.self_fencing).toBeUndefined();

		expect(h.calls.snapshot).toBe(0);
		expect(h.calls.apply).toBe(0);
		expect(h.calls.revert).toBe(0);
		expect(h.clock.timers).toHaveLength(0);
		expect(JSON.stringify(h.box.state)).toBe(before);
		expect(h.dispatchedCount()).toBe(0);
	});

	test("the refusal names the same condition the modem procedures refuse with", () => {
		expect(SELF_FENCING_NOT_READY_ERROR).toBe(
			CELLULAR_STACK_INITIALIZING.toLowerCase(),
		);
	});

	test("the gate is transient: the next command applies once the stack lands", async () => {
		enterInitializing();

		const refused = harness();
		await routeCommand(makeCommand({ cid: CID_INIT }), refused.deps);
		expect(refused.results[0]?.payload.ok).toBe(false);

		releaseInit?.({ ok: true });
		releaseInit = undefined;
		await flush();
		expect(getCellularStack().ready).toBe(true);

		const accepted = harness();
		await routeCommand(makeCommand({ cid: CID_AFTER }), accepted.deps);

		expect(accepted.calls.order).toEqual(["snapshot", "apply"]);
		expect(accepted.results[0]?.payload.ok).toBe(true);
		expect(accepted.results[0]?.self_fencing).toBe(true);
	});

	test("a degraded mmcli fallback is still a ready stack and applies", async () => {
		resetStack();
		await initCellularStack({
			backend: "dbus",
			createDbusBackend: () => ({
				start: async (): Promise<CellularStartResult> => {
					throw new Error("no bus");
				},
				stop: async (): Promise<void> => undefined,
			}),
		});
		expect(getCellularStack().degraded).toBe(true);
		expect(getCellularStack().ready).toBe(true);

		const h = harness();
		await routeCommand(makeCommand({ cid: CID_AFTER }), h.deps);

		expect(h.calls.apply).toBe(1);
		expect(h.results[0]?.payload.ok).toBe(true);
	});

	test("the explicit mmcli rollback backend has no init window at all", async () => {
		resetStack();
		getConfig().modem_backend = "mmcli";
		expect(getCellularStack().ready).toBe(true);

		await initCellularStack({});
		expect(getCellularStack().backend).toBe("mmcli");
		expect(getCellularStack().ready).toBe(true);
	});
});
