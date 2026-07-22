// @vitest-environment jsdom
/**
 * LiveView — summary coherence (Task 12): one transport token per idle surface,
 * encoder row names the REAL capture source.
 *
 * Complements LiveView.idle-order.test.ts (which mounts the real IdleCockpit →
 * StreamSetupChain → SourceSection subtree). Here we assert the exact rendered
 * strings the summary-coherence pass guarantees against that same real subtree:
 *
 *   1. The encoder config row names the source by the SAME display name the
 *      source list shows — `RØDE HDMI to USB-C: RØDE HDMI · 5 Mbps` — and drops
 *      the trailing `· SRTLA` transport token it used to carry.
 *   2. The idle active-config line (SourceSection `active-config-value`) has NO
 *      transport token.
 *   3. The Destination/server row STILL carries `SRTLA` (the ONE idle surface
 *      that names the transport).
 *   4. QA: the literal `SRTLA` appears in exactly ONE `[data-testid]` region of
 *      the idle-cockpit DOM.
 */
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

// LiveView statically imports `navElements` from `$lib/config`, which transitively
// pulls the full destination-view graph (incl. DevTools → pwa → window.matchMedia,
// absent in jsdom). Mock it to just the one export LiveView reads.
vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

// `config.source` resolves to the RØDE capture source below; a managed
// `relay_server` (no `remote_provider`) makes the server row a bonded SRTLA
// relay; a live netif keeps the network gate green.
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => ({
		source: "usb",
		relay_server: "fra",
		max_br: 5000,
		pipeline: "hdmi",
	}),
	getIsStreaming: () => false,
	getSensors: () => ({}),
	getLinkTelemetry: () => null,
	getAudioLevel: () => undefined,
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
	getSources: () => ({
		hardware: "rk3588",
		sources: [
			{
				origin: "capture",
				id: "usb",
				pipelineId: "libuvch264",
				kind: "uvc_h264",
				displayName: "RØDE HDMI to USB-C: RØDE HDMI",
				devicePath: "/dev/video1",
				modes: [],
				supportsAudio: true,
				supportsResolutionOverride: true,
				supportsFramerateOverride: true,
				audioKind: "selectable",
				available: true,
			},
		],
	}),
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
// LiveHeader is a SEPARATE always-visible surface (its own chip may show the
// destination + kind) — it lives OUTSIDE idle-cockpit, so stubbing it keeps the
// QA count scoped to the idle-cockpit region as the real DOM behaves.
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
	default: (await import("../tests/fixtures/Noop.svelte")).default,
}));

import LiveView from "./LiveView.svelte";

function idleCockpit(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>(
		'[data-testid="idle-cockpit"]',
	);
	if (!el) throw new Error("idle-cockpit did not mount");
	return el;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("LiveView — summary coherence (Task 12)", () => {
	it("encoder row names the REAL capture source with no transport token", () => {
		const { container } = render(LiveView);
		const encoderRow = idleCockpit(container).querySelector<HTMLElement>(
			'[data-testid="setup-row"][data-section="encoder"]',
		);
		expect(encoderRow, "encoder setup-row renders").not.toBeNull();
		// The summary <p> is the second paragraph in the row's label column.
		const value = encoderRow?.querySelector("p.font-mono");
		expect(value?.textContent?.trim()).toBe(
			"RØDE HDMI to USB-C: RØDE HDMI · 5 Mbps",
		);
		// Belt-and-braces: the transport token is gone from the encoder row.
		expect(encoderRow?.textContent).not.toContain("SRTLA");
	});

	it("idle active-config line carries no transport token", () => {
		const { container } = render(LiveView);
		const activeConfig = idleCockpit(container).querySelector<HTMLElement>(
			'[data-testid="active-config-value"]',
		);
		expect(activeConfig, "active-config line renders").not.toBeNull();
		expect(activeConfig?.textContent).toContain(
			"RØDE HDMI to USB-C: RØDE HDMI",
		);
		expect(activeConfig?.textContent).not.toContain("SRTLA");
	});

	it("Destination/server row still contains SRTLA", () => {
		const { container } = render(LiveView);
		const serverRow = idleCockpit(container).querySelector<HTMLElement>(
			'[data-testid="setup-row"][data-section="server"]',
		);
		expect(serverRow, "server setup-row renders").not.toBeNull();
		expect(serverRow?.textContent).toContain("SRTLA");
	});

	it("QA: 'SRTLA' appears in exactly ONE [data-testid] region of the idle cockpit", () => {
		const { container } = render(LiveView);
		const idle = idleCockpit(container);
		// The innermost (leaf) testid regions carrying SRTLA: a testid element that
		// contains SRTLA AND has no descendant testid that also contains SRTLA — so
		// an ancestor wrapper (idle-cockpit, stream-setup-chain) is never counted.
		const leafRegions = Array.from(
			idle.querySelectorAll<HTMLElement>("[data-testid]"),
		).filter((el) => {
			if (!(el.textContent ?? "").includes("SRTLA")) return false;
			return !Array.from(el.querySelectorAll("[data-testid]")).some((child) =>
				(child.textContent ?? "").includes("SRTLA"),
			);
		});
		expect(leafRegions.map((el) => el.dataset.testid)).toEqual(["setup-row"]);
	});
});
