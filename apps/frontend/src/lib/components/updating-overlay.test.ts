// @vitest-environment jsdom
/**
 * updating-overlay — the persistent overlay shown during a software update.
 *
 * Regression lock for a truthfulness bug: `details.result` is a NUMBER (`0`
 * marks success) OR a STRING (the apt failure message). The pre-fix logic
 * collapsed both into one `isComplete` boolean and UNCONDITIONALLY fired the
 * green success toast + checkmark — so a FAILED update lied and reported
 * success.
 *
 * RED-first: against the old `const isComplete = details?.result !== undefined
 * || ...` line, a string (failure) result made `isComplete` true and fired
 * `toast.success` — the first test below (failure → error, not success) would
 * FAIL. GREEN after splitting into `isFailure` (string result) vs `isSuccess`
 * (numeric/progress-complete). The happy-path test proves the success path is
 * not regressed.
 */
import type { UpdateProgress } from "@ceraui/rpc/schemas";
import { render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import UpdatingOverlay from "./updating-overlay.svelte";

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

function progress(overrides: Partial<UpdateProgress> = {}): UpdateProgress {
	return {
		downloading: 0,
		unpacking: 0,
		setting_up: 0,
		total: 1,
		...overrides,
	};
}

beforeEach(() => {
	toastSuccess.mockReset();
	toastError.mockReset();
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("updating-overlay terminal state", () => {
	it("shows a FAILURE indicator + error toast (never success) when the result is an apt error string", async () => {
		const reason = "E: Could not get lock /var/lib/dpkg/lock";
		// vaul-svelte portals Drawer.Content to document.body, so query `document`.
		render(UpdatingOverlay, {
			props: { details: progress({ result: reason }) },
		});

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError.mock.calls[0]?.[1]).toMatchObject({
			description: reason,
		});

		// The green success path must NOT fire for a failed update.
		expect(toastSuccess).not.toHaveBeenCalled();

		const failed = document.querySelector('[data-testid="update-failed"]');
		expect(failed).not.toBeNull();
		expect(
			document.querySelector('[data-testid="update-failed-reason"]')
				?.textContent,
		).toContain(reason);
	});

	it("keeps the success toast for a genuine (numeric result) completion", async () => {
		render(UpdatingOverlay, {
			props: { details: progress({ result: 0 }) },
		});

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastError).not.toHaveBeenCalled();
	});

	it("keeps the success toast for a progress-complete run with no result yet", async () => {
		render(UpdatingOverlay, {
			props: {
				details: progress({
					downloading: 1,
					unpacking: 1,
					setting_up: 1,
					total: 1,
				}),
			},
		});

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastError).not.toHaveBeenCalled();
	});
});
