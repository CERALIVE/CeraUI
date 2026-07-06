// @vitest-environment jsdom
/**
 * WifiSelectorDialog — background-scan failure surfacing (Task 20,
 * live-correctness-pass).
 *
 * The periodic (silent) rescan routes through `osCommand` with `silent: true`,
 * so a failing tick is CAUGHT (no unhandled rejection, no toast) and surfaced
 * ONLY through the derived `scanError` flag
 * (`getOperationPhase(scanKey|periodicScanKey) === 'failed'`), which drives the
 * calm `wifi-scan-error` band. A subsequent successful tick re-arms the op and
 * clears it.
 *
 * This exercises the exact osCommand seam WifiSelectorDialog's periodic effect
 * drives — same `periodicScanKey` shape, same `{ silent: true, confirmOnResolve }`
 * options — against the real store `scanError` reads. The band render given a
 * `scanError` flag is proven separately by `WifiNetworkList.test.ts`; the
 * full-dialog render is intentionally NOT mounted here (its 22s rescan interval
 * plus the awaited async settle wedge the vitest worker).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	destroyAsyncOperations,
	getOperationPhase,
	osCommand,
} from "$lib/rpc/async-operation.svelte";

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

import { toast } from "svelte-sonner";

const toastError = vi.mocked(toast.error);

// Mirrors WifiSelectorDialog's `periodicScanKey = \`wifi-scan-auto:${deviceId}\``.
const PERIODIC_KEY = "wifi-scan-auto:0";

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("WifiSelectorDialog — periodic silent-scan wiring (Task 20)", () => {
	it("a failing background tick transitions to `failed` WITHOUT a toast (calm band, not an interruption)", async () => {
		await osCommand({
			key: PERIODIC_KEY,
			rpc: () => Promise.reject(new Error("scan failed")),
			confirmOnResolve: true,
			silent: true,
		});

		// `scanError` derives true from this `failed` phase → the calm band renders.
		expect(getOperationPhase(PERIODIC_KEY)).toBe("failed");
		// silent: true → a background op never interrupts with a toast.
		expect(toastError).not.toHaveBeenCalled();
	});

	it("the next successful tick confirms the op, clearing the scan-error surface", async () => {
		await osCommand({
			key: PERIODIC_KEY,
			rpc: () => Promise.reject(new Error("scan failed")),
			confirmOnResolve: true,
			silent: true,
		});
		expect(getOperationPhase(PERIODIC_KEY)).toBe("failed");

		await osCommand({
			key: PERIODIC_KEY,
			rpc: () => Promise.resolve({}),
			confirmOnResolve: true,
			silent: true,
		});

		// `confirmed` (not `failed`) → `scanError` derives false → band clears.
		expect(getOperationPhase(PERIODIC_KEY)).toBe("confirmed");
		expect(toastError).not.toHaveBeenCalled();
	});
});
