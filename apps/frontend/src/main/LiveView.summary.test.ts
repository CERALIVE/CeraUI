// @vitest-environment jsdom
/**
 * LiveView — post-stream summary window (T24 fix).
 *
 * IngestStats' historical "Session ended · {duration}" summary lives inside
 * LiveCockpit and only paints while `isStreaming !== true`, but LiveCockpit used
 * to unmount the instant `isStreaming` flipped false (`optimisticIsStreaming`
 * dropped in the same tick) — so the summary was unreachable in production. This
 * suite locks the fix: after a REAL stream stop LiveView holds LiveCockpit
 * mounted in `summaryMode` for a bounded window (so the still-mounted IngestStats
 * can render the summary), then reverts to IdleCockpit when the window expires,
 * and a subsequent stream start resets the window immediately.
 *
 * `getIsStreaming()` is read through a reactive `.svelte.ts` seam so a
 * `streamingFlag.value = …; flushSync()` drives LiveView's real reactivity
 * (the summary-window `$effect` + `showLiveCockpit`/`summaryMode` deriveds); the
 * bounded timeout is advanced with fake timers.
 */
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamingFlag } from "../tests/fixtures/reactive-streaming.svelte";

// The fixed post-stream summary window in LiveView (SUMMARY_WINDOW_MS).
const SUMMARY_WINDOW_MS = 30_000;

// LiveView statically imports `navElements` from `$lib/config`, which transitively
// pulls the full destination-view graph (incl. DevTools → pwa → window.matchMedia,
// absent in jsdom). Mock it to just the one export LiveView reads.
vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

// getIsStreaming reads the reactive seam so the derived re-runs on mutation; every
// other getter is a stable stub. Optimism is held `idle` (the stop path we test
// is the authoritative `is_streaming` flip, not a user-initiated stopping edge).
vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { streamingFlag } = await import(
		"../tests/fixtures/reactive-streaming.svelte"
	);
	return {
		getConfig: () => ({ relay_server: "fra", max_br: 6000, pipeline: "hdmi" }),
		getIsStreaming: () => streamingFlag.value,
		getSensors: () => ({}),
		getLinkTelemetry: () => null,
		getDevices: () => [],
		getActiveInput: () => undefined,
		getConnectionState: () => "connected",
		getIsConnected: () => true,
		getCapabilities: () => undefined,
		getNetif: () => ({}),
		getRelays: () => undefined,
		getManagedIngestAccounts: () => [],
		getStatus: () => ({}),
		getPipelines: () => ({ pipelines: {} }),
		getSources: () => undefined,
	};
});

vi.mock("$lib/rpc/streaming-optimism.svelte", () => ({
	getStreamingOptimismState: () => "idle",
	getStreamingStopReason: () => undefined,
	startStreamingOptimism: vi.fn(),
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: vi.fn(),
	revertStreamingOptimism: vi.fn(),
}));

// Stub the two cockpits to their identifying testids; the LiveCockpit stub mirrors
// `summaryMode` onto `data-summary-mode` so the summary window is assertable.
vi.mock("$main/live/IdleCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/IdleCockpitStub.svelte")).default,
}));
vi.mock("$main/live/LiveCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/LiveCockpitStub.svelte")).default,
}));

// Stub the remaining direct children so the parent mounts without their graphs.
vi.mock("$main/live/LiveHeader.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/CapabilityTierBanner.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/ServerDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/AudioDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/EncoderDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/ComingSoon.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));

import LiveView from "./LiveView.svelte";

function liveCockpit(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>('[data-testid="live-cockpit"]');
}
function idleCockpit(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>('[data-testid="idle-cockpit"]');
}

beforeEach(() => {
	vi.useFakeTimers();
	streamingFlag.reset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("LiveView — post-stream summary window", () => {
	it("keeps LiveCockpit mounted in summaryMode after a real stop, then reverts to IdleCockpit when the window expires", () => {
		const { container } = render(LiveView);

		// Idle: only the IdleCockpit.
		expect(liveCockpit(container)).toBeNull();
		expect(idleCockpit(container)).not.toBeNull();

		// Start streaming: LiveCockpit shows in live mode (not summaryMode).
		streamingFlag.value = true;
		flushSync();
		expect(liveCockpit(container)).not.toBeNull();
		expect(liveCockpit(container)?.getAttribute("data-summary-mode")).toBe("false");
		expect(idleCockpit(container)).toBeNull();

		// Stop: LiveCockpit STAYS mounted, now in summaryMode (the historical
		// summary window) — it does NOT immediately swap to IdleCockpit.
		streamingFlag.value = false;
		flushSync();
		expect(
			liveCockpit(container),
			"LiveCockpit stays mounted through the post-stream summary window",
		).not.toBeNull();
		expect(liveCockpit(container)?.getAttribute("data-summary-mode")).toBe("true");
		expect(idleCockpit(container)).toBeNull();

		// The window is bounded: after the timeout it reverts to IdleCockpit.
		vi.advanceTimersByTime(SUMMARY_WINDOW_MS);
		flushSync();
		expect(
			liveCockpit(container),
			"the summary window closes on the bounded timeout",
		).toBeNull();
		expect(idleCockpit(container)).not.toBeNull();
	});

	it("does not open a summary window on a plain idle mount (no session)", () => {
		const { container } = render(LiveView);
		// Never streamed → no summary window, straight IdleCockpit even after time.
		vi.advanceTimersByTime(SUMMARY_WINDOW_MS);
		flushSync();
		expect(liveCockpit(container)).toBeNull();
		expect(idleCockpit(container)).not.toBeNull();
	});

	it("resets the summary window on the next stream start (back to live mode, not summary)", () => {
		const { container } = render(LiveView);

		// Stream, then stop → in the summary window.
		streamingFlag.value = true;
		flushSync();
		streamingFlag.value = false;
		flushSync();
		expect(liveCockpit(container)?.getAttribute("data-summary-mode")).toBe("true");

		// Start again mid-window: the cockpit is live again (summaryMode cleared),
		// not lingering in the historical summary.
		streamingFlag.value = true;
		flushSync();
		expect(liveCockpit(container)).not.toBeNull();
		expect(liveCockpit(container)?.getAttribute("data-summary-mode")).toBe("false");
		expect(idleCockpit(container)).toBeNull();

		// And the previous window's timer no longer fires a spurious revert.
		vi.advanceTimersByTime(SUMMARY_WINDOW_MS);
		flushSync();
		expect(
			liveCockpit(container),
			"a restart cancels the prior window timer — still live",
		).not.toBeNull();
		expect(liveCockpit(container)?.getAttribute("data-summary-mode")).toBe("false");
	});
});
