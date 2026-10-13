// @vitest-environment jsdom
/**
 * The install overlay's terminal verdict comes from the device's RESULT, never
 * from progress counters reaching their totals (sweep C3, ruling D208).
 *
 * The counters are cumulative and reach their total before apt has exited, so
 * a run that is still finishing, or about to fail, would be called a success,
 * and the one-shot latch would then swallow the real failure.
 */
import type { UpdateProgress } from "@ceraui/rpc/schemas";
import { render, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import UpdatingOverlay from "./updating-overlay.svelte";

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

const COMPLETE: UpdateProgress = {
	downloading: 1,
	unpacking: 1,
	setting_up: 1,
	total: 1,
};

beforeEach(() => {
	toastSuccess.mockReset();
	toastError.mockReset();
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("updating-overlay: success needs the device's result", () => {
	it("full counters with no result yet show no success", async () => {
		// Given every counter at its total and no result reported.
		render(UpdatingOverlay, { props: { details: COMPLETE } });
		await new Promise((resolve) => setTimeout(resolve, 600));

		// Then nothing claims the update succeeded.
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain("Successfully Updated");
	});

	it("a failure after full counters still reaches the operator", async () => {
		// Given full counters, then the device's failure result.
		const view = render(UpdatingOverlay, { props: { details: COMPLETE } });
		await new Promise((resolve) => setTimeout(resolve, 600));
		await view.rerender({
			details: { ...COMPLETE, result: "E: dpkg was interrupted" },
		});
		flushSync();

		// Then the failure toast fires and no success toast ever did.
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("full counters, then the success result, is a success", async () => {
		const view = render(UpdatingOverlay, { props: { details: COMPLETE } });
		await view.rerender({ details: { ...COMPLETE, result: 0 } });
		flushSync();
		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastError).not.toHaveBeenCalled();
		expect(toastSuccess).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				description: expect.stringContaining("not confirmed"),
			}),
		);
	});
});
