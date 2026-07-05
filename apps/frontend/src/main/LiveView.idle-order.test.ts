// @vitest-environment jsdom
/**
 * LiveView — source-first idle cockpit order + source-fix retarget (Task T10).
 *
 * Complements LiveView.test.ts (the idle/live mutual-exclusion contract, which
 * stubs the cockpits). Here the REAL IdleCockpit → StreamSetupChain →
 * SourceSection → StreamControlButton subtree is mounted so the plan's two T10
 * DOM contracts can be asserted against rendered markup:
 *
 *   1. DOM order within `idle-cockpit`: `source-section` precedes
 *      `stream-setup-chain` precedes the Start button (compareDocumentPosition).
 *   2. Source-gate retarget: a blocked source gate renders the encoder row's
 *      openSource fix; clicking it scrolls the source list into view + focuses it
 *      and does NOT open the EncoderDialog.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LiveView statically imports `navElements` from `$lib/config`, which transitively
// pulls the full destination-view graph (incl. DevTools → pwa → window.matchMedia,
// absent in jsdom). Mock it to just the one export LiveView reads.
vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

// Config carries NO `source` → the source gate is blocked (encoder row blocked +
// openSource fix), but relay_server + a live netif keep destination/network green.
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({ relay_server: "fra", max_br: 6000, pipeline: "hdmi" }),
	getIsStreaming: () => false,
	getSensors: () => ({}),
	getLinkTelemetry: () => null,
	getDevices: () => [],
	getActiveInput: () => undefined,
	getConnectionState: () => "connected",
	getIsConnected: () => true,
	getCapabilities: () => undefined,
	getNetif: () => ({ eth0: { enabled: true, ip: "10.0.0.2" } }),
	getRelays: () => undefined,
	getManagedIngestAccounts: () => [],
	getStatus: () => ({}),
	getPipelines: () => ({ pipelines: {} }),
	getSources: () => ({ hardware: "rk3588", sources: [] }),
}));

vi.mock("$lib/rpc/streaming-optimism.svelte", () => ({
	getStreamingOptimismState: () => "idle",
	getStreamingStopReason: () => undefined,
	getStopStuckBannerVisible: () => false,
	startStreamingOptimism: vi.fn(),
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: vi.fn(),
	revertStreamingOptimism: vi.fn(),
	retryStopStreaming: vi.fn(),
}));

// SourceSection's QR effect — stubbed so it never touches the QR lib at mount.
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => ""),
}));

// Stub the heavy peripherals so ONLY the idle cockpit subtree mounts for real.
vi.mock("$main/live/LiveHeader.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/CapabilityTierBanner.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/LiveCockpit.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/preview/PreviewCanvas.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/ComingSoon.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/ServerDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/AudioDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/EncoderDialog.svelte", async () => ({
	default: (await import("../tests/fixtures/EncoderDialogOpenStub.svelte"))
		.default,
}));

import LiveView from "./LiveView.svelte";

const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

beforeEach(() => {
	// jsdom implements neither scrollIntoView nor a real layout — spy on it so the
	// retarget can be asserted without a real scroll.
	Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("LiveView — source-first idle cockpit order (T10)", () => {
	it("renders source-section before stream-setup-chain before the Start button", () => {
		const { container } = render(LiveView);
		const idle = container.querySelector<HTMLElement>(
			'[data-testid="idle-cockpit"]',
		);
		expect(idle, "idle cockpit mounts").not.toBeNull();

		const section = idle?.querySelector<HTMLElement>(
			'[data-testid="source-section"]',
		);
		const chain = idle?.querySelector<HTMLElement>(
			'[data-testid="stream-setup-chain"]',
		);
		const start = within(idle as HTMLElement).getByRole("button", {
			name: /start stream/i,
		});

		expect(section, "source-section renders").not.toBeNull();
		expect(chain, "stream-setup-chain renders").not.toBeNull();

		// compareDocumentPosition, not a brittle first-child check: source precedes
		// chain, and the chain precedes (contains) the Start button.
		expect(
			(section as HTMLElement).compareDocumentPosition(chain as HTMLElement) &
				FOLLOWING,
			"source-section precedes stream-setup-chain",
		).toBeTruthy();
		expect(
			(chain as HTMLElement).compareDocumentPosition(start) & FOLLOWING,
			"stream-setup-chain precedes the Start button",
		).toBeTruthy();
		expect(
			(section as HTMLElement).compareDocumentPosition(start) & FOLLOWING,
			"source-section precedes the Start button",
		).toBeTruthy();
	});

	it("mounts the Start control exactly once (no double StreamControlButton)", () => {
		const { container } = render(LiveView);
		expect(
			within(container).getAllByRole("button", { name: /start stream/i }),
			"exactly one Start control",
		).toHaveLength(1);
	});
});

describe("LiveView — blocked source gate retargets to the source list (T10)", () => {
	it("clicking the encoder-row openSource fix scrolls/focuses source, does NOT open EncoderDialog", async () => {
		const { container } = render(LiveView);
		const section = container.querySelector<HTMLElement>(
			'[data-testid="source-section"]',
		);
		expect(section, "source-section is a scroll target").not.toBeNull();

		const fix = container.querySelector<HTMLElement>(
			'[data-testid="setup-row-fix"][data-fix="openSource"]',
		);
		expect(fix, "blocked encoder row exposes an openSource fix").not.toBeNull();

		await fireEvent.click(fix as HTMLElement);

		// Scroll retarget fired on the source-section (not the encoder dialog).
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
		expect(
			(Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock
				.instances[0],
			"scrollIntoView was called on the source-section",
		).toBe(section);

		// Focus moved to the source list container (falls back to the section root
		// when the list is empty).
		expect(
			document.activeElement,
			"focus retargets into the source section",
		).toBe(section);

		// The EncoderDialog stayed closed — the fix does NOT open it.
		expect(
			container.querySelector('[data-testid="encoder-dialog-open"]'),
			"EncoderDialog did NOT open",
		).toBeNull();
	});
});
