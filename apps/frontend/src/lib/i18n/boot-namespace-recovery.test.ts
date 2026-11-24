import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recoverBootNamespace } from "./boot-namespace-recovery";

const fetchFailure = new TypeError(
	"Failed to fetch dynamically imported module: https://device.local/assets/navigation.js",
);

describe("boot namespace recovery", () => {
	const reload = vi.fn();

	beforeEach(() => {
		reload.mockClear();
		vi.stubGlobal("location", { reload });
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("allows one reload across failed documents in the same tab", async () => {
		recoverBootNamespace(fetchFailure);
		await vi.runAllTimersAsync();
		expect(reload).toHaveBeenCalledTimes(1);

		recoverBootNamespace(fetchFailure);
		await vi.runAllTimersAsync();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it.each([
		new TypeError("Cannot read properties of undefined"),
		new Error(fetchFailure.message),
	])("leaves other boot exceptions to the watchdog: %s", async (error) => {
		recoverBootNamespace(error);
		await vi.runAllTimersAsync();
		expect(reload).not.toHaveBeenCalled();
	});

	it("leaves manual recovery available when storage rejects the reservation", async () => {
		vi.stubGlobal("sessionStorage", {
			getItem: () => null,
			setItem: () => {
				throw new DOMException("Storage is blocked", "QuotaExceededError");
			},
		});
		recoverBootNamespace(fetchFailure);
		await vi.runAllTimersAsync();
		expect(reload).not.toHaveBeenCalled();
	});
});
