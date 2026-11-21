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

const downloading = { total: 1, downloading: 1, unpacking: 0, setting_up: 0 };
const installing = { total: 1, downloading: 0, unpacking: 0, setting_up: 1 };

describe("updating-overlay package progress", () => {
	it("shows activity without inventing a number before APT reports one", async () => {
		render(UpdatingOverlay, { props: { details: progress({ total: 0 }) } });

		const bar = await screen.findByRole("progressbar", { name: "Progress" });
		expect(bar.getAttribute("aria-valuenow")).toBeNull();
		expect(screen.getByTestId("update-phase").textContent).toContain(
			"Preparing or downloading packages",
		);
		expect(screen.queryByText(/^\d+%$|of \d+ steps/)).toBeNull();
	});

	it("shows APT's download percentage, then its install percentage", async () => {
		const view = render(UpdatingOverlay, {
			props: { details: progress(downloading) },
		});
		const bar = await screen.findByRole("progressbar", { name: "Progress" });
		expect(screen.getByTestId("update-phase").textContent).toContain(
			"Downloading",
		);
		expect(bar.getAttribute("aria-valuenow")).toBeNull();

		for (const [details, phase, percent] of [
			[progress({ ...downloading, percent: 41 }), "Downloading", 41],
			[progress({ ...installing, percent: 0 }), "Installing", 0],
			[progress({ ...installing, percent: 60 }), "Installing", 60],
		] as const) {
			await view.rerender({ details });
			expect(screen.getByTestId("update-phase").textContent).toContain(phase);
			expect(screen.getByText(`${percent}%`)).toBeDefined();
			expect(bar.getAttribute("aria-valuenow")).toBe(String(percent));
			expect(bar.getAttribute("aria-valuemax")).toBe("100");
			expect(bar.getAttribute("aria-valuetext")).toBe(`${percent}%`);
		}
		expect(screen.queryByText(/of \d+ steps/)).toBeNull();
	});

	it("shows the install phase without a number when only the transcript proves it", async () => {
		render(UpdatingOverlay, { props: { details: progress(installing) } });
		const bar = await screen.findByRole("progressbar", { name: "Progress" });
		expect(screen.getByTestId("update-phase").textContent).toContain(
			"Installing",
		);
		expect(bar.getAttribute("aria-valuenow")).toBeNull();
		expect(screen.queryByText(/^\d+%$/)).toBeNull();
	});

	it("reaches 100% only on the device's success result", async () => {
		const details = progress({ ...installing, percent: 99 });
		const view = render(UpdatingOverlay, { props: { details } });
		const bar = await screen.findByRole("progressbar", { name: "Progress" });
		expect(screen.getByText("99%")).toBeDefined();
		expect(screen.queryByText("100%")).toBeNull();
		await view.rerender({ details: { ...details, result: 0 } });
		expect(bar.getAttribute("aria-valuenow")).toBe("100");
		expect(screen.getByText("100%")).toBeDefined();
	});
});

describe("updating-overlay terminal state", () => {
	it.each([
		["failed", "dpkg: post-installation script returned error exit status 1"],
		["interrupted without stderr", ""],
	])(
		"does not show completion before or after an install is %s",
		async (_, result) => {
			const details = progress({ ...installing, percent: 80 });
			const view = render(UpdatingOverlay, { props: { details } });
			const bar = await screen.findByRole("progressbar", { name: "Progress" });

			expect(screen.getByTestId("update-phase").textContent).toContain(
				"Installing",
			);
			expect(bar.getAttribute("aria-valuetext")).toBe("80%");
			expect(screen.queryByText("100%")).toBeNull();
			expect(toastSuccess).not.toHaveBeenCalled();

			await view.rerender({ details: { ...details, result } });
			expect(screen.getByTestId("update-failed")).toBeDefined();
			expect(screen.queryByText("80%")).toBeNull();
			expect(screen.queryByText("100%")).toBeNull();
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
