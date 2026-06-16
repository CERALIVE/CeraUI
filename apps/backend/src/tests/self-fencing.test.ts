import { afterEach, describe, expect, test } from "bun:test";

import type { Command, Result } from "../modules/remote-control/protocol.ts";
import {
	handleSelfFencingConfirm,
	handleSelfFencingOp,
	type NonRevertibleOp,
	type RevertibleOp,
	resetSelfFencingState,
	type SelfFencingDeps,
	type SelfFencingOps,
} from "../modules/remote-control/self-fencing.ts";

const CID_A = "5e81b246-1a7c-4f5e-9261-9d0e1f2a3b40";
const CID_B = "5e81b246-1a7c-4f5e-9261-9d0e1f2a3b41";
const CID_C = "5e81b246-1a7c-4f5e-9261-9d0e1f2a3b42";
const CID_D = "5e81b246-1a7c-4f5e-9261-9d0e1f2a3b43";
const CID_E = "5e81b246-1a7c-4f5e-9261-9d0e1f2a3b44";

interface FakeTimer {
	fn: () => void;
	ms: number;
	cleared: boolean;
}

interface FakeClock {
	timers: FakeTimer[];
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

function capture(): { frames: Result[]; sink: (frame: Result) => boolean } {
	const frames: Result[] = [];
	return {
		frames,
		sink: (frame: Result) => {
			frames.push(frame);
			return true;
		},
	};
}

function revertibleSpy(states: { old: unknown; new: unknown }): {
	op: RevertibleOp;
	calls: { snapshot: number; apply: number; revert: unknown[] };
} {
	const calls = { snapshot: 0, apply: 0, revert: [] as unknown[] };
	const op: RevertibleOp = {
		revertible: true,
		snapshot: async () => {
			calls.snapshot += 1;
			return states.old;
		},
		apply: async () => {
			calls.apply += 1;
			return states.new;
		},
		revert: async (snapshot) => {
			calls.revert.push(snapshot);
		},
	};
	return { op, calls };
}

function nonRevertibleSpy(): {
	op: NonRevertibleOp;
	calls: { execute: unknown[] };
} {
	const calls = { execute: [] as unknown[] };
	const op: NonRevertibleOp = {
		revertible: false,
		execute: async (payload) => {
			calls.execute.push(payload);
		},
	};
	return { op, calls };
}

/** Fill the full op table with a throwing default, then overlay the op under test. */
function makeOps(partial: Partial<SelfFencingOps>): SelfFencingOps {
	const unexpected: NonRevertibleOp = {
		revertible: false,
		execute: async () => {
			throw new Error("unexpected op invocation");
		},
	};
	return {
		"network.reconfig": unexpected,
		"modem.reconfig": unexpected,
		"device.remoteKeyChange": unexpected,
		"system.reboot": unexpected,
		"device.factoryReset": unexpected,
		...partial,
	};
}

function makeDeps(
	ops: SelfFencingOps,
	clock: FakeClock,
	sink: (frame: Result) => boolean,
): Partial<SelfFencingDeps> {
	return {
		sendResult: sink,
		ops,
		watchdogMs: 30_000,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		logger: { info: () => {}, warn: () => {} },
	};
}

function makeCommand(overrides: Partial<Command>): Command {
	return {
		v: 1,
		kind: "command",
		type: "network.reconfig",
		cid: CID_A,
		role: "owner",
		self_fencing: true,
		...overrides,
	};
}

afterEach(() => {
	resetSelfFencingState();
});

describe("self_fencing revertible ops", () => {
	test("network.reconfig auto-reverts to the snapshot when no confirm arrives", async () => {
		const { frames, sink } = capture();
		const clock = fakeClock();
		const { op, calls } = revertibleSpy({
			old: { dhcp: true },
			new: { dhcp: false },
		});

		await handleSelfFencingOp(
			makeCommand({ type: "network.reconfig", cid: CID_A }),
			makeDeps(makeOps({ "network.reconfig": op }), clock, sink),
		);

		expect(calls.snapshot).toBe(1);
		expect(calls.apply).toBe(1);
		expect(frames).toHaveLength(1);
		expect(frames[0]?.kind).toBe("result");
		expect(frames[0]?.cid).toBe(CID_A);
		expect(frames[0]?.self_fencing).toBe(true);
		expect(frames[0]?.payload).toEqual({ ok: true, applied: { dhcp: false } });
		expect(clock.timers).toHaveLength(1);
		expect(clock.timers[0]?.ms).toBe(30_000);

		await clock.fire();

		expect(calls.revert).toEqual([{ dhcp: true }]);
		expect(frames).toHaveLength(2);
		expect(frames[1]?.payload).toEqual({
			ok: true,
			applied: { dhcp: true },
			reverted: true,
		});
	});

	test("network.reconfig commits without reverting when confirmed in time", async () => {
		const { frames, sink } = capture();
		const clock = fakeClock();
		const { op, calls } = revertibleSpy({
			old: { dhcp: true },
			new: { dhcp: false },
		});

		await handleSelfFencingOp(
			makeCommand({ type: "network.reconfig", cid: CID_B }),
			makeDeps(makeOps({ "network.reconfig": op }), clock, sink),
		);
		await handleSelfFencingConfirm(CID_B);

		expect(calls.revert).toEqual([]);
		expect(clock.timers[0]?.cleared).toBe(true);
		expect(frames).toHaveLength(2);
		expect(frames[1]?.payload).toEqual({
			ok: true,
			applied: { dhcp: false },
			reverted: false,
		});

		// Firing the cancelled watchdog is a no-op — the op was already resolved.
		await clock.fire();
		expect(calls.revert).toEqual([]);
		expect(frames).toHaveLength(2);
	});
});

describe("self_fencing non-revertible ops", () => {
	test("system.reboot without a confirm yields self_fencing_confirm_required and does not execute", async () => {
		const { frames, sink } = capture();
		const clock = fakeClock();
		const { op, calls } = nonRevertibleSpy();

		await handleSelfFencingOp(
			makeCommand({ type: "system.reboot", cid: CID_C }),
			makeDeps(makeOps({ "system.reboot": op }), clock, sink),
		);

		expect(calls.execute).toEqual([]);
		expect(frames).toHaveLength(1);
		expect(frames[0]?.payload).toEqual({
			ok: false,
			applied: null,
			error: "self_fencing_confirm_required",
		});
		expect(clock.timers).toHaveLength(1);
	});

	test("system.reboot executes only after a matching confirm", async () => {
		const { frames, sink } = capture();
		const clock = fakeClock();
		const { op, calls } = nonRevertibleSpy();

		await handleSelfFencingOp(
			makeCommand({
				type: "system.reboot",
				cid: CID_D,
				payload: { mode: "graceful" },
			}),
			makeDeps(makeOps({ "system.reboot": op }), clock, sink),
		);
		expect(calls.execute).toEqual([]);

		await handleSelfFencingConfirm(CID_D);

		expect(calls.execute).toEqual([{ mode: "graceful" }]);
		expect(clock.timers[0]?.cleared).toBe(true);
		expect(frames).toHaveLength(2);
		expect(frames[1]?.payload).toEqual({ ok: true, applied: null });
	});

	test("system.reboot is discarded with self_fencing_unconfirmed when the watchdog fires", async () => {
		const { frames, sink } = capture();
		const clock = fakeClock();
		const { op, calls } = nonRevertibleSpy();

		await handleSelfFencingOp(
			makeCommand({ type: "system.reboot", cid: CID_E }),
			makeDeps(makeOps({ "system.reboot": op }), clock, sink),
		);
		await clock.fire();

		expect(calls.execute).toEqual([]);
		expect(frames).toHaveLength(2);
		expect(frames[1]?.payload).toEqual({
			ok: false,
			applied: null,
			error: "self_fencing_unconfirmed",
		});
	});
});
