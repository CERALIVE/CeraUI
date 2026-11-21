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
import { render, screen, waitFor } from "@testing-library/svelte";
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

describe("updating-overlay package acquisition", () => {
	it("counts completed steps in both the text and bar as two packages advance", async () => {
		const view = render(UpdatingOverlay, {
			props: { details: progress({ total: 2, downloading: 2 }) },
		});
		const bar = await screen.findByRole("progressbar");

		for (const [unpacking, setting_up, completed, percent] of [
			[1, 0, 2, 33],
			[2, 0, 3, 50],
			[2, 1, 4, 66],
			[2, 2, 5, 83],
		]) {
			await view.rerender({
				details: progress({ total: 2, downloading: 2, unpacking, setting_up }),
			});
			expect(screen.getByText(`${completed} of 6 steps`)).toBeDefined();
			expect(screen.getAllByText(`${percent}%`)).toHaveLength(2);
			expect(bar.getAttribute("aria-valuenow")).toBe(String(completed));
			expect(bar.getAttribute("aria-valuemax")).toBe("6");
			expect(bar.getAttribute("aria-valuetext")).toBe(`${percent}%`);
			expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
		}
	});

	it("rounds down near completion and reaches 100% only on success", async () => {
		const details = progress({
			total: 67,
			downloading: 67,
			unpacking: 67,
			setting_up: 66,
		});
		const view = render(UpdatingOverlay, { props: { details } });
		const bar = await screen.findByRole("progressbar");
		expect(screen.queryByText("100%")).toBeNull();
		expect(screen.getAllByText("99%")).toHaveLength(2);
		expect(bar.getAttribute("aria-valuenow")).toBe("199");
		expect(bar.getAttribute("aria-valuemax")).toBe("201");
		await view.rerender({ details: { ...details, setting_up: 67 } });
		expect(bar.getAttribute("aria-valuenow")).toBe("200");
		expect(screen.getByText("200 of 201 steps")).toBeDefined();
		expect(screen.getAllByText("99%")).toHaveLength(2);
		await view.rerender({ details: { ...details, setting_up: 67, result: 0 } });
		expect(bar.getAttribute("aria-valuenow")).toBe("201");
		expect(screen.getAllByText("100%")).toHaveLength(2);
	});

	it("shows activity without inventing steps while apt has emitted no counters", async () => {
		render(UpdatingOverlay, { props: { details: progress({ total: 0 }) } });

		const bar = await screen.findByRole("progressbar");
		expect(bar.getAttribute("aria-valuenow")).toBeNull();
		expect(screen.getByTestId("update-phase").textContent).toContain(
			"Preparing or downloading packages",
		);
		expect(screen.queryByText(/0 of 1 steps|0%/)).toBeNull();
	});

	it("keeps a single-package fetch indeterminate until unpacking actually starts", async () => {
		// Get:1 identifies a fetch that started, not bytes transferred.
		const view = render(UpdatingOverlay, {
			props: { details: progress({ downloading: 1 }) },
		});

		const bar = await screen.findByRole("progressbar");
		expect(bar.getAttribute("aria-valuenow")).toBeNull();
		expect(screen.getByTestId("update-phase").textContent).toContain(
			"Downloading",
		);
		expect(screen.queryByText("1/1")).toBeNull();

		await view.rerender({
			details: progress({ downloading: 1, unpacking: 1 }),
		});
		expect(bar.getAttribute("aria-valuenow")).toBe("1");
		expect(screen.getByTestId("update-phase").textContent).toContain(
			"Unpacking",
		);

		await view.rerender({
			details: progress({ downloading: 1, unpacking: 1, setting_up: 1 }),
		});
		expect(screen.getByTestId("update-phase").textContent).toContain(
			"Installing",
		);
	});
});

describe("updating-overlay terminal state", () => {
	it.each([
		["failed", "dpkg: post-installation script returned error exit status 1"],
		["interrupted without stderr", ""],
	])(
		"does not show completion before or after an install is %s",
		async (_, result) => {
			// The final "Setting up" record precedes postinst, even if the unit
			// exits unsuccessfully. A signaled unit can report an empty error string.
			const details = progress({ downloading: 1, unpacking: 1, setting_up: 1 });
			const view = render(UpdatingOverlay, { props: { details } });
			const bar = await screen.findByRole("progressbar");

			expect(screen.getByTestId("update-phase").textContent).toContain(
				"Installing",
			);
			expect(screen.getByText("2 of 3 steps")).toBeDefined();
			expect(bar.getAttribute("aria-valuenow")).toBe("2");
			expect(bar.getAttribute("aria-valuetext")).toBe("66%");
			expect(screen.queryByText("1/1")).toBeNull();
			expect(screen.queryByText("100%")).toBeNull();
			expect(toastSuccess).not.toHaveBeenCalled();

			await view.rerender({ details: { ...details, result } });
			expect(screen.getByTestId("update-failed")).toBeDefined();
			expect(screen.queryByText("1/1")).toBeNull();
			expect(screen.queryByText("100%")).toBeNull();
			expect(screen.queryByText("3 of 3 steps")).toBeNull();
			expect(bar.getAttribute("aria-valuenow")).toBeNull();
			expect(toastSuccess).not.toHaveBeenCalled();
		},
	);

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

	// Ruling D208 (sweep C3): this case used to toast success on full counters
	// with NO result. The counters reach their totals before apt exits, so the
	// success now waits for the device's result; the toast itself still fires.
	it("keeps the success toast for a progress-complete run once the result arrives", async () => {
		const complete = progress({
			downloading: 1,
			unpacking: 1,
			setting_up: 1,
			total: 1,
		});
		const view = render(UpdatingOverlay, { props: { details: complete } });
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(toastSuccess).not.toHaveBeenCalled();

		await view.rerender({ details: { ...complete, result: 0 } });

		await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
		expect(toastError).not.toHaveBeenCalled();
	});
});
