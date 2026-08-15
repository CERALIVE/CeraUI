import { afterEach, describe, expect, it, vi } from "vitest";

import {
	LAZY_DIALOG_FALLBACK_DELAY_MS,
	type LazyDialogComponent,
	lazyDialog,
} from "./lazy-dialog.svelte";

const STUB = (() => undefined) as unknown as LazyDialogComponent;

afterEach(() => {
	vi.useRealTimers();
});

describe("lazyDialog", () => {
	it("fetches nothing until the dialog is first requested", async () => {
		const load = vi.fn(async () => ({ default: STUB }));
		const registration = lazyDialog(load);

		expect(load).not.toHaveBeenCalled();
		expect(registration.current).toBeUndefined();
		expect(registration.pending).toBe(false);
		expect(registration.failed).toBe(false);
	});

	it("resolves the component on request", async () => {
		const load = vi.fn(async () => ({ default: STUB }));
		const registration = lazyDialog(load);

		registration.request();
		await vi.waitFor(() => expect(registration.current).toBe(STUB));
		expect(load).toHaveBeenCalledTimes(1);
	});

	// The second open of a dialog must cost nothing — an inline `{#await import()}`
	// at the mount site would re-fetch, which is why the registry exists.
	it("fetches once however many times it is requested", async () => {
		const load = vi.fn(async () => ({ default: STUB }));
		const registration = lazyDialog(load);

		registration.request();
		registration.request();
		await vi.waitFor(() => expect(registration.current).toBe(STUB));
		registration.request();

		expect(load).toHaveBeenCalledTimes(1);
	});

	it("shows no loading chrome for a chunk that lands inside the delay", async () => {
		vi.useFakeTimers();
		const load = vi.fn(async () => ({ default: STUB }));
		const registration = lazyDialog(load);

		registration.request();
		await vi.advanceTimersByTimeAsync(LAZY_DIALOG_FALLBACK_DELAY_MS - 1);

		expect(registration.current).toBe(STUB);
		expect(registration.pending).toBe(false);
	});

	it("shows loading chrome once a chunk outlives the delay", async () => {
		vi.useFakeTimers();
		let release:
			| ((module: { default: LazyDialogComponent }) => void)
			| undefined;
		const registration = lazyDialog(
			() =>
				new Promise<{ default: LazyDialogComponent }>((resolve) => {
					release = resolve;
				}),
		);

		registration.request();
		await vi.advanceTimersByTimeAsync(LAZY_DIALOG_FALLBACK_DELAY_MS);
		expect(registration.pending).toBe(true);
		expect(registration.current).toBeUndefined();

		release?.({ default: STUB });
		await vi.waitFor(() => expect(registration.current).toBe(STUB));
		expect(registration.pending).toBe(false);
	});

	// A chunk that cannot be fetched must state so rather than leave the operator
	// clicking a button that does nothing.
	it("surfaces a failed fetch and recovers on retry", async () => {
		const load = vi
			.fn<() => Promise<{ default: LazyDialogComponent }>>()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce({ default: STUB });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const registration = lazyDialog(load);

		registration.request();
		await vi.waitFor(() => expect(registration.failed).toBe(true));
		expect(registration.pending).toBe(true);
		expect(registration.current).toBeUndefined();

		registration.retry();
		await vi.waitFor(() => expect(registration.current).toBe(STUB));
		expect(registration.failed).toBe(false);
		expect(load).toHaveBeenCalledTimes(2);

		errorSpy.mockRestore();
	});
});
