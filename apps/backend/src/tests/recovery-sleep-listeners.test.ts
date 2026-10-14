import { expect, spyOn, test } from "bun:test";
import { defaultRuntimeConfigBootDeps } from "../modules/config-boot.ts";
import { sleepUnlessAborted } from "../modules/modems/mutation-recovery-owner.ts";

type AbortListener = Parameters<AbortSignal["addEventListener"]>[1];

for (const [name, sleep] of [
	["modem", sleepUnlessAborted],
	["config", defaultRuntimeConfigBootDeps.sleep],
] as const) {
	test(`${name} completed default waits remove every abort listener`, async () => {
		// Given one real signal and an injected timer-completion ledger.
		const controller = new AbortController(),
			signal = controller.signal;
		const added = signal.addEventListener.bind(signal),
			removed = signal.removeEventListener.bind(signal);
		const listeners = new Set<AbortListener>();
		const add = spyOn(signal, "addEventListener").mockImplementation(
			(
				type: string,
				listener: AbortListener,
				options?: Parameters<AbortSignal["addEventListener"]>[2],
			) => {
				if (type === "abort" && listener) listeners.add(listener);
				added(type, listener, options);
			},
		);
		const remove = spyOn(signal, "removeEventListener").mockImplementation(
			(
				type: string,
				listener: AbortListener,
				options?: Parameters<AbortSignal["removeEventListener"]>[2],
			) => {
				if (type === "abort" && listener) listeners.delete(listener);
				removed(type, listener, options);
			},
		);
		const realTimer = globalThis.setTimeout;
		const completions: (() => void)[] = [],
			timers: ReturnType<typeof setTimeout>[] = [];
		const fakeTimeout = ((
			callback: (...values: unknown[]) => void,
			_ms?: number,
			...args: unknown[]
		) => {
			const handle = realTimer(() => undefined, 60_000);
			timers.push(handle);
			completions.push(() => {
				clearTimeout(handle);
				callback(...args);
			});
			return handle;
		}) as unknown as typeof setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(
			fakeTimeout,
		);
		try {
			const retained: number[] = [];
			// When twelve waits complete normally on the same flight signal.
			for (let i = 0; i < 12; i++) {
				const wait = sleep(60_000, signal);
				completions.shift()?.();
				await wait;
				retained.push(listeners.size);
			}
			// Then no completed closure remains; a pending wait still aborts and cleans up.
			expect(retained).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
			const wait = sleep(60_000, signal);
			expect(listeners.size).toBe(1);
			controller.abort();
			await wait;
			expect(listeners.size).toBe(0);
		} finally {
			controller.abort();
			for (const handle of timers) clearTimeout(handle);
			timer.mockRestore();
			add.mockRestore();
			remove.mockRestore();
		}
	});
	test(`${name} pre-aborted default wait arms neither timer nor listener`, async () => {
		// Given an already-cancelled flight.
		const controller = new AbortController();
		controller.abort();
		const realTimer = globalThis.setTimeout,
			timers: ReturnType<typeof setTimeout>[] = [];
		const fakeTimeout = (() => {
			const handle = realTimer(() => undefined, 60_000);
			timers.push(handle);
			return handle;
		}) as unknown as typeof setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(
			fakeTimeout,
		);
		const add = spyOn(controller.signal, "addEventListener");
		try {
			// When the default receives cancellation before construction.
			const wait = sleep(60_000, controller.signal);
			// Then it resolves without allocating resources.
			expect(timer.mock.calls).toEqual([]);
			expect(add.mock.calls).toEqual([]);
			await wait;
		} finally {
			for (const handle of timers) clearTimeout(handle);
			timer.mockRestore();
			add.mockRestore();
		}
	});
}
