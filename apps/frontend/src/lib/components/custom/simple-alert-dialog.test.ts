// @vitest-environment jsdom
/**
 * SimpleAlertDialog — async confirm loading (Task 29).
 *
 * The confirm action may return a Promise. While that promise is pending the
 * dialog must stay open in a loading state: the confirm button is disabled,
 * `aria-busy` flips true, and a spinner renders. The dialog closes (its
 * `bind:open` flips false) only once the promise SETTLES — on resolve AND on
 * reject — so a failed OS-action never leaves the dialog wedged open or, worse,
 * closes before the operator's RPC has actually settled.
 *
 * bits-ui's `AlertDialog.Action` carries no auto-close of its own (only the
 * Cancel/Close primitives do), so the dialog's open lifecycle is owned entirely
 * by the component's explicit `open = false` after the promise settles.
 *
 * Coverage:
 *  1. Pending  — confirm disabled + spinner + aria-busy while the promise is
 *                unresolved; dialog stays open; onconfirm fires exactly once.
 *  2. Resolve  — once the promise resolves the dialog closes.
 *  3. Reject   — a rejected confirm still settles: the dialog closes (prior
 *                state) and the rejection never becomes an unhandled error.
 */
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import SimpleAlertDialog from "./simple-alert-dialog.svelte";

/** Deferred promise so a test can hold a confirm "in-flight" deterministically. */
function defer<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("SimpleAlertDialog — async confirm loading (Task 29)", () => {
	it("disables the confirm button and shows a spinner while the async confirm is pending", async () => {
		const gate = defer();
		const onconfirm = vi.fn(() => gate.promise);

		const { getByRole } = render(SimpleAlertDialog, {
			props: { open: true, confirmButtonText: "Confirm", onconfirm },
		});

		const confirm = getByRole("button", {
			name: "Confirm",
		}) as HTMLButtonElement;
		// Sanity: enabled and not busy before the operator acts.
		expect(confirm.disabled).toBe(false);
		expect(confirm.getAttribute("aria-busy")).toBe("false");
		// Dialog content is portaled to document.body, so query there (not container).
		expect(document.body.querySelector(".animate-spin")).toBeNull();

		await fireEvent.click(confirm);

		// The confirm fired exactly once and the dialog entered its loading state.
		expect(onconfirm).toHaveBeenCalledTimes(1);
		await waitFor(() => {
			const c = getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
			expect(c.disabled).toBe(true);
			expect(c.getAttribute("aria-busy")).toBe("true");
		});
		// A spinner is visible on the button while pending.
		expect(document.body.querySelector(".animate-spin")).not.toBeNull();

		// And the dialog is STILL open — it must not close until the promise settles.
		expect(getByRole("button", { name: "Confirm" })).not.toBeNull();
	});

	it("closes the dialog once the async confirm resolves", async () => {
		const gate = defer();
		const onconfirm = vi.fn(() => gate.promise);

		const { getByRole, queryByRole } = render(SimpleAlertDialog, {
			props: { open: true, confirmButtonText: "Confirm", onconfirm },
		});

		await fireEvent.click(getByRole("button", { name: "Confirm" }));
		// Still open while pending.
		expect(queryByRole("button", { name: "Confirm" })).not.toBeNull();

		gate.resolve();
		// After the promise settles the dialog closes — the confirm button leaves the DOM.
		await waitFor(() =>
			expect(queryByRole("button", { name: "Confirm" })).toBeNull(),
		);
	});

	it("settles to closed when the async confirm rejects (failure path)", async () => {
		const gate = defer();
		const onconfirm = vi.fn(() => gate.promise);

		const { getByRole, queryByRole } = render(SimpleAlertDialog, {
			props: { open: true, confirmButtonText: "Confirm", onconfirm },
		});

		await fireEvent.click(getByRole("button", { name: "Confirm" }));
		expect(queryByRole("button", { name: "Confirm" })).not.toBeNull();

		// Reject mid-flight: the dialog must still settle (close), not wedge open.
		gate.reject(new Error("os action failed"));

		await waitFor(() =>
			expect(queryByRole("button", { name: "Confirm" })).toBeNull(),
		);
		// onconfirm was only ever invoked once across the whole flow.
		expect(onconfirm).toHaveBeenCalledTimes(1);
	});

	it("keeps the original immediate-close behaviour for a synchronous confirm", async () => {
		const onconfirm = vi.fn(() => {
			/* synchronous: returns undefined, not a promise */
		});

		const { getByRole, queryByRole } = render(SimpleAlertDialog, {
			props: { open: true, confirmButtonText: "Confirm", onconfirm },
		});

		await fireEvent.click(getByRole("button", { name: "Confirm" }));

		// Sync confirm closes the dialog immediately (no loading latch).
		await waitFor(() =>
			expect(queryByRole("button", { name: "Confirm" })).toBeNull(),
		);
		expect(onconfirm).toHaveBeenCalledTimes(1);
	});
});
