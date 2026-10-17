// @vitest-environment jsdom
/**
 * UnconfirmedStreamBand — the Stop an operator needs when the device holds
 * stream protection it cannot confirm (`reconciling` / `stop_failed`) while the
 * last confirmed `is_streaming` is false.
 *
 * Expectations are literal: the English copy, the RPC called, the phase the band
 * shows. Nothing here derives an expectation from the production predicate.
 */
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	destroyAsyncOperations,
	getOperationPhase,
	initAsyncOperations,
	sweepOperations,
} from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { noteLifecycleDelivered } from "$lib/rpc/session-epoch.svelte";

import UnconfirmedStreamBand from "./UnconfirmedStreamBand.svelte";

vi.mock("$lib/rpc/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/rpc/client")>()),
	rpc: { streaming: { stop: vi.fn() } },
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { toast } from "svelte-sonner";

const stop = vi.mocked(rpc.streaming.stop);

const TITLE = "Stream state not confirmed";
const BODY =
	"The device can't confirm whether a stream is still running, so starting a stream and installing updates are paused. Stop the stream to end anything that may still be running; both resume once the device confirms it has stopped.";
const FAILED =
	"The device didn't confirm the stop. Try stopping the stream again.";
const NOT_CONFIRMED =
	"The stop was sent, but the device hasn't confirmed it yet. You can try again.";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function band(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>(
		'[data-testid="unconfirmed-stream-band"]',
	);
}
function stopButton(container: HTMLElement): HTMLButtonElement {
	const button = container.querySelector<HTMLButtonElement>(
		'[data-testid="unconfirmed-stream-stop"]',
	);
	if (!button) throw new Error("Stop button not rendered");
	return button;
}

beforeEach(() => {
	vi.clearAllMocks();
	// main.ts warms the store before mount; first creating it inside the band's
	// $derived would detach it from the component's reactive graph.
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("UnconfirmedStreamBand — rendered in every protected lifecycle", () => {
	for (const lifecycle of ["reconciling", "stop_failed"] as const) {
		it(`${lifecycle}: band, honest copy and a reachable Stop`, () => {
			const { container } = render(UnconfirmedStreamBand, {
				props: { lifecycle, isStreaming: false, optimismState: "idle" },
			});
			const root = band(container);
			expect(root).not.toBeNull();
			expect(root?.getAttribute("role")).toBe("status");
			expect(root?.getAttribute("aria-live")).toBe("polite");
			expect(root?.getAttribute("data-lifecycle")).toBe(lifecycle);
			expect(root?.textContent).toContain(TITLE);
			expect(root?.textContent).toContain(BODY);

			const button = stopButton(container);
			expect(button.tagName).toBe("BUTTON");
			expect(button.getAttribute("type")).toBe("button");
			expect(button.disabled).toBe(false);
			expect(button.textContent?.trim()).toBe("Stop Stream");
			// Touch target matches StreamControlButton's 44px floor; full width on a
			// phone, natural width from `sm` up.
			expect(button.className).toContain("min-h-[44px]");
			expect(button.className).toContain("w-full");
			expect(button.className).toContain("sm:w-auto");
			button.focus();
			expect(document.activeElement).toBe(button);
		});
	}

	// FIX-16-C3: local `starting` optimism no longer hides the band. The
	// optimistic live cockpit's control is a disabled "Starting...", so C2's
	// assumption that it supplies a Stop was wrong (these two cells were in the
	// negative matrix below).
	for (const lifecycle of ["reconciling", "stop_failed"] as const) {
		it(`${lifecycle}: still shown under a stale local starting optimism`, () => {
			const { container } = render(UnconfirmedStreamBand, {
				props: { lifecycle, isStreaming: false, optimismState: "starting" },
			});
			expect(band(container)).not.toBeNull();
			expect(stopButton(container).disabled).toBe(false);
			expect(stopButton(container).textContent?.trim()).toBe("Stop Stream");
		});
	}

	it("stays visible through the cockpit's optimistic stopping overlay", () => {
		const { container } = render(UnconfirmedStreamBand, {
			props: {
				lifecycle: "stop_failed",
				isStreaming: false,
				optimismState: "stopping",
			},
		});
		expect(band(container)).not.toBeNull();
	});
});

describe("UnconfirmedStreamBand — renders nothing outside the unconfirmed set", () => {
	const cells = [
		{ lifecycle: undefined, isStreaming: false, optimismState: "idle" },
		{ lifecycle: "idle", isStreaming: false, optimismState: "idle" },
		{ lifecycle: "starting", isStreaming: false, optimismState: "idle" },
		{ lifecycle: "starting", isStreaming: false, optimismState: "starting" },
		{ lifecycle: "streaming", isStreaming: true, optimismState: "idle" },
		{ lifecycle: "stopping", isStreaming: false, optimismState: "stopping" },
		{ lifecycle: "stopping", isStreaming: true, optimismState: "idle" },
		{ lifecycle: "reconfiguring", isStreaming: true, optimismState: "idle" },
		{ lifecycle: "reconciling", isStreaming: true, optimismState: "idle" },
		{ lifecycle: "stop_failed", isStreaming: true, optimismState: "idle" },
	] as const;
	for (const props of cells) {
		it(`${props.lifecycle}|${props.isStreaming}|${props.optimismState}: no band, no Stop`, () => {
			const { container } = render(UnconfirmedStreamBand, { props });
			expect(band(container)).toBeNull();
			expect(
				container.querySelector('[data-testid="unconfirmed-stream-stop"]'),
			).toBeNull();
			expect(container.textContent?.trim()).toBe("");
		});
	}
});

describe("UnconfirmedStreamBand — the Stop it offers", () => {
	it("dispatches streaming.stop once, with no input, and holds a pending state", async () => {
		const reply = deferred<{ result: "stopped"; success: true }>();
		stop.mockReturnValueOnce(reply.promise as never);
		const { container } = render(UnconfirmedStreamBand, {
			props: {
				lifecycle: "reconciling",
				isStreaming: false,
				optimismState: "idle",
			},
		});

		await fireEvent.click(stopButton(container));
		expect(stop).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledWith();
		expect(band(container)?.getAttribute("data-phase")).toBe("pending");
		expect(stopButton(container).disabled).toBe(true);
		expect(stopButton(container).getAttribute("aria-busy")).toBe("true");
		expect(stopButton(container).textContent?.trim()).toBe("Stopping...");

		// A second press while the first is in flight dispatches nothing.
		await fireEvent.click(stopButton(container));
		expect(stop).toHaveBeenCalledTimes(1);

		reply.resolve({ result: "stopped", success: true });
		await reply.promise;
		flushSync();
		// The reply alone is not the evidence: still pending until the lifecycle moves.
		expect(getOperationPhase("stream-stop-unconfirmed")).toBe("pending");
		expect(band(container)).not.toBeNull();
	});

	it("is settled by the lifecycle push that leaves the unconfirmed set", async () => {
		stop.mockResolvedValueOnce({ result: "stopped", success: true } as never);
		const { container, rerender } = render(UnconfirmedStreamBand, {
			props: {
				lifecycle: "stop_failed",
				isStreaming: false,
				optimismState: "idle",
			},
		});
		await fireEvent.click(stopButton(container));
		await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
		expect(getOperationPhase("stream-stop-unconfirmed")).toBe("pending");

		// In the app a lifecycle prop only changes because a status frame carrying
		// it arrived; that frame stamps the delivery witness on the current link,
		// which is what lets it confirm a pending Stop (FIX-16-F4 C4-1).
		noteLifecycleDelivered();
		await rerender({
			lifecycle: "idle",
			isStreaming: false,
			optimismState: "idle",
		});
		flushSync();
		expect(band(container)).toBeNull();
		expect(getOperationPhase("stream-stop-unconfirmed")).toBe("confirmed");
	});

	it("shows the refusal inline and re-enables Stop when the device answers stop_failed", async () => {
		stop.mockResolvedValueOnce({
			result: "stop_failed",
			reason: "stop_timeout",
			success: false,
		} as never);
		const { container } = render(UnconfirmedStreamBand, {
			props: {
				lifecycle: "stop_failed",
				isStreaming: false,
				optimismState: "idle",
			},
		});
		await fireEvent.click(stopButton(container));
		await waitFor(() =>
			expect(band(container)?.getAttribute("data-phase")).toBe("failed"),
		);
		expect(
			container
				.querySelector('[data-testid="unconfirmed-stream-failed"]')
				?.textContent?.trim(),
		).toBe(FAILED);
		// The raw reason token is never rendered.
		expect(band(container)?.textContent).not.toContain("stop_timeout");
		expect(stopButton(container).disabled).toBe(false);
		expect(stopButton(container).textContent?.trim()).toBe("Stop Stream");
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();

		stop.mockResolvedValueOnce({ result: "stopped", success: true } as never);
		await fireEvent.click(stopButton(container));
		expect(stop).toHaveBeenCalledTimes(2);
	});

	it("treats a thrown RPC as a failure, inline", async () => {
		stop.mockRejectedValueOnce(new Error("socket closed"));
		const { container } = render(UnconfirmedStreamBand, {
			props: {
				lifecycle: "reconciling",
				isStreaming: false,
				optimismState: "idle",
			},
		});
		await fireEvent.click(stopButton(container));
		await waitFor(() =>
			expect(band(container)?.getAttribute("data-phase")).toBe("failed"),
		);
		expect(band(container)?.textContent).toContain(FAILED);
		expect(band(container)?.textContent).not.toContain("socket closed");
		expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
	});

	it("says the stop is not confirmed yet when the shared TTL lapses with no lifecycle push", async () => {
		stop.mockResolvedValueOnce({ result: "stopped", success: true } as never);
		const { container } = render(UnconfirmedStreamBand, {
			props: {
				lifecycle: "reconciling",
				isStreaming: false,
				optimismState: "idle",
			},
		});
		await fireEvent.click(stopButton(container));
		await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

		sweepOperations(Date.now() + 15_001);
		flushSync();
		expect(band(container)?.getAttribute("data-phase")).toBe("timed_out");
		expect(
			container
				.querySelector('[data-testid="unconfirmed-stream-timed-out"]')
				?.textContent?.trim(),
		).toBe(NOT_CONFIRMED);
		expect(stopButton(container).disabled).toBe(false);
	});
});

describe("UnconfirmedStreamBand — the band's disappearance is not a confirmation", () => {
	it("stop_failed -> stopping keeps the Stop pending and on screen; the stop_failed reply fails it", async () => {
		const reply = deferred<unknown>();
		stop.mockReturnValueOnce(reply.promise as never);
		const { container, rerender } = render(UnconfirmedStreamBand, {
			props: {
				lifecycle: "stop_failed",
				isStreaming: false,
				optimismState: "idle",
			},
		});
		await fireEvent.click(stopButton(container));

		await rerender({
			lifecycle: "stopping",
			isStreaming: false,
			optimismState: "idle",
		});
		flushSync();
		expect(getOperationPhase("stream-stop-unconfirmed")).toBe("pending");
		expect(band(container)?.getAttribute("data-lifecycle")).toBe("stopping");
		expect(stopButton(container).disabled).toBe(true);
		expect(stopButton(container).textContent?.trim()).toBe("Stopping...");

		await rerender({
			lifecycle: "stop_failed",
			isStreaming: false,
			optimismState: "idle",
		});
		reply.resolve({
			result: "stop_failed",
			reason: "stop_timeout",
			success: false,
		});
		await waitFor(() =>
			expect(band(container)?.getAttribute("data-phase")).toBe("failed"),
		);
		expect(band(container)?.textContent).toContain(FAILED);
		expect(stopButton(container).disabled).toBe(false);
	});

	it("is_streaming true while the Stop is pending hides the band but does not confirm", async () => {
		stop.mockReturnValueOnce(new Promise(() => {}) as never);
		const { container, rerender } = render(UnconfirmedStreamBand, {
			props: {
				lifecycle: "reconciling",
				isStreaming: false,
				optimismState: "idle",
			},
		});
		await fireEvent.click(stopButton(container));
		await rerender({
			lifecycle: "streaming",
			isStreaming: true,
			optimismState: "idle",
		});
		flushSync();
		expect(band(container)).toBeNull();
		expect(getOperationPhase("stream-stop-unconfirmed")).toBe("pending");
	});
});
