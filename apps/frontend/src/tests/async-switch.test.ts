import { describe, expect, it, vi } from "vitest";

import {
	guardedToggle,
	type PendingRef,
} from "$lib/components/custom/async-switch";

/** A standalone {@link PendingRef} backed by a plain mutable boolean. */
function createPendingRef(): PendingRef & { value: boolean } {
	const ref = {
		value: false,
		get() {
			return ref.value;
		},
		set(value: boolean) {
			ref.value = value;
		},
	};
	return ref;
}

/** Deferred promise so a test can hold a call "in-flight" deterministically. */
function defer(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("guardedToggle — AsyncSwitch pending guard", () => {
	it("ignores a re-entrant click while a call is in-flight (no double-RPC)", async () => {
		const pending = createPendingRef();
		const gate = defer();
		const onCheckedChange = vi.fn(() => gate.promise);

		// First click starts the call and takes the in-flight lock.
		const first = guardedToggle(true, onCheckedChange, pending);
		expect(pending.get()).toBe(true);

		// Rapid second click while still in-flight — must be dropped.
		const second = guardedToggle(true, onCheckedChange, pending);

		expect(onCheckedChange).toHaveBeenCalledTimes(1);

		gate.resolve();
		await Promise.all([first, second]);

		// Still exactly one RPC, and the lock is released afterwards.
		expect(onCheckedChange).toHaveBeenCalledTimes(1);
		expect(pending.get()).toBe(false);
	});

	it("re-enables the control and reverts state on rejection (pessimistic)", async () => {
		const pending = createPendingRef();
		// Parent state advances ONLY after the RPC resolves; reject leaves it put.
		const parent = { checked: false };
		const onCheckedChange = vi.fn((value: boolean) =>
			Promise.reject(new Error("rpc failed")).then(() => {
				parent.checked = value;
			}),
		);
		const onError = vi.fn();

		await guardedToggle(true, onCheckedChange, pending, onError);

		expect(onCheckedChange).toHaveBeenCalledTimes(1);
		expect(parent.checked).toBe(false); // reverted: never advanced to the new value
		expect(pending.get()).toBe(false); // re-enabled, not stuck disabled
		expect(onError).toHaveBeenCalledTimes(1);
	});

	it("advances state only after the RPC resolves (pessimistic commit)", async () => {
		const pending = createPendingRef();
		const parent = { checked: false };
		const gate = defer();
		const onCheckedChange = vi.fn((value: boolean) =>
			gate.promise.then(() => {
				parent.checked = value;
			}),
		);

		const call = guardedToggle(true, onCheckedChange, pending);

		// While in-flight the parent state has NOT moved yet.
		expect(parent.checked).toBe(false);
		expect(pending.get()).toBe(true);

		gate.resolve();
		await call;

		expect(parent.checked).toBe(true);
		expect(pending.get()).toBe(false);
	});
});
