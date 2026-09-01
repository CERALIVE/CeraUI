import { describe, expect, it } from "bun:test";
import {
	withDeviceLock,
	withModemUpdateLock,
} from "../modules/network/state/device-lock.ts";

/** Resolve-later promise + its resolver, for controlling fn timing in tests. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("withDeviceLock", () => {
	it("rejects a concurrent op on the same device with DEVICE_BUSY and never calls fn", async () => {
		const gate = deferred<string>();

		// First op acquires the lock and stays pending until we release the gate.
		const first = withDeviceLock("wlan0", () => gate.promise);

		// Second op on the SAME device while the first is in-flight.
		let secondFnCalled = false;
		const second = await withDeviceLock("wlan0", async () => {
			secondFnCalled = true;
			return "should-not-run";
		});

		expect(second.success).toBe(false);
		if (!second.success) {
			expect(second.error).toBe("DEVICE_BUSY");
		}
		expect(secondFnCalled).toBe(false);

		// Let the first op finish so we don't leak the lock.
		gate.resolve("done");
		const firstResult = await first;
		expect(firstResult.success).toBe(true);
		if (firstResult.success) {
			expect(firstResult.result).toBe("done");
		}
	});

	it("releases the lock on success so the next acquire succeeds", async () => {
		const firstResult = await withDeviceLock("eth0", async () => 42);
		expect(firstResult.success).toBe(true);
		if (firstResult.success) {
			expect(firstResult.result).toBe(42);
		}

		// Same device, after completion — should acquire freely.
		let secondFnCalled = false;
		const secondResult = await withDeviceLock("eth0", async () => {
			secondFnCalled = true;
			return 99;
		});
		expect(secondFnCalled).toBe(true);
		expect(secondResult.success).toBe(true);
		if (secondResult.success) {
			expect(secondResult.result).toBe(99);
		}
	});

	it("releases the lock on throw (no deadlock) so the next acquire succeeds", async () => {
		await expect(
			withDeviceLock("wlan1", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		// Lock must be free again despite the throw.
		let secondFnCalled = false;
		const secondResult = await withDeviceLock("wlan1", async () => {
			secondFnCalled = true;
			return "recovered";
		});
		expect(secondFnCalled).toBe(true);
		expect(secondResult.success).toBe(true);
		if (secondResult.success) {
			expect(secondResult.result).toBe("recovered");
		}
	});

	it("runs different devices in parallel without blocking each other", async () => {
		const gateA = deferred<string>();
		const gateB = deferred<string>();

		let aFnCalled = false;
		let bFnCalled = false;

		const a = withDeviceLock("wlan0", async () => {
			aFnCalled = true;
			return gateA.promise;
		});
		const b = withDeviceLock("eth0", async () => {
			bFnCalled = true;
			return gateB.promise;
		});

		// Both fns should be running concurrently — neither blocks the other.
		expect(aFnCalled).toBe(true);
		expect(bFnCalled).toBe(true);

		gateA.resolve("a-done");
		gateB.resolve("b-done");

		const [resA, resB] = await Promise.all([a, b]);
		expect(resA.success).toBe(true);
		expect(resB.success).toBe(true);
		if (resA.success) {
			expect(resA.result).toBe("a-done");
		}
		if (resB.success) {
			expect(resB.result).toBe("b-done");
		}
	});
});

describe("withModemUpdateLock", () => {
	it("coalesces every mid-update request into exactly one trailing run", async () => {
		const gate = deferred<void>();
		const runs: Array<string> = [];

		// Given one update that is still in flight
		const first = withModemUpdateLock(async () => {
			runs.push("first");
			await gate.promise;
		});

		// When several callers request reconciliation before it settles
		const queued = ["event-1", "event-2", "event-3"].map((label) =>
			withModemUpdateLock(async () => {
				runs.push(label);
			}),
		);

		gate.resolve();
		await Promise.all([first, ...queued]);

		// Then the active run is followed by one latest-state reconciliation
		expect(runs).toEqual(["first", "event-3"]);
	});

	it("releases on throw so subsequent calls still run", async () => {
		await expect(
			withModemUpdateLock(async () => {
				throw new Error("modem-boom");
			}),
		).rejects.toThrow("modem-boom");

		let nextFnCalled = false;
		await withModemUpdateLock(async () => {
			nextFnCalled = true;
		});
		expect(nextFnCalled).toBe(true);
	});
});
