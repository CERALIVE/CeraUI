import { afterEach, describe, expect, it, vi } from "vitest";

import { notifyHistoryChanged, onHistoryChanged } from "./history-bus";

const subscriptions: Array<() => void> = [];

function subscribe(listener: () => void): () => void {
	const off = onHistoryChanged(listener);
	subscriptions.push(off);
	return off;
}

afterEach(() => {
	for (const off of subscriptions.splice(0)) off();
	vi.restoreAllMocks();
});

describe("history bus", () => {
	it("calls every registered listener once per notification, in registration order", () => {
		const calls: string[] = [];
		subscribe(() => calls.push("raw"));
		subscribe(() => calls.push("boots"));

		notifyHistoryChanged();
		expect(calls).toEqual(["raw", "boots"]);

		notifyHistoryChanged();
		expect(calls).toEqual(["raw", "boots", "raw", "boots"]);
	});

	it("is a no-op with no listeners", () => {
		const error = vi.spyOn(console, "error");
		expect(() => notifyHistoryChanged()).not.toThrow();
		expect(error).toHaveBeenCalledTimes(0);
	});

	it("stops calling a listener after its unsubscribe, and unsubscribe is idempotent", () => {
		const kept = vi.fn();
		const dropped = vi.fn();
		subscribe(kept);
		const off = subscribe(dropped);

		off();
		off();
		notifyHistoryChanged();

		expect(dropped).toHaveBeenCalledTimes(0);
		expect(kept).toHaveBeenCalledTimes(1);
	});

	it("keeps two registrations of the same function independent", () => {
		const listener = vi.fn();
		const first = subscribe(listener);
		subscribe(listener);

		notifyHistoryChanged();
		expect(listener).toHaveBeenCalledTimes(2);

		first();
		notifyHistoryChanged();
		expect(listener).toHaveBeenCalledTimes(3);
	});

	it("contains a throwing listener, reports it, and still calls the rest", () => {
		const failure = new Error("region unmounted");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const after = vi.fn();
		subscribe(() => {
			throw failure;
		});
		subscribe(after);

		expect(() => notifyHistoryChanged()).not.toThrow();

		expect(after).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledExactlyOnceWith(
			"System Logs history listener failed:",
			failure,
		);
	});

	it("notifies the listeners registered when the notification started", () => {
		const late = vi.fn();
		const removed = vi.fn();
		let offRemoved: () => void = () => {};
		subscribe(() => {
			offRemoved();
			subscribe(late);
		});
		offRemoved = subscribe(removed);

		notifyHistoryChanged();
		expect(removed).toHaveBeenCalledTimes(1);
		expect(late).toHaveBeenCalledTimes(0);

		notifyHistoryChanged();
		expect(removed).toHaveBeenCalledTimes(1);
		expect(late).toHaveBeenCalledTimes(1);
	});
});
