// @vitest-environment jsdom
/**
 * GoLiveCard — one adaptive readiness + config + start surface (Task 10).
 *
 * Locks the contracts the plan pins:
 *   • the three migrated config-row testids are present (open-encoder/audio/server);
 *   • a blocked gate renders its reason + an inline fix button that opens the
 *     right surface (destination → ServerDialog callback), and Start is disabled
 *     with the matching reason;
 *   • all gates ok + valid rows (idle) collapses to the "Ready to go live" bar,
 *     re-expandable;
 *   • while streaming the config rows lock (Lock affordance, no edit trigger);
 *   • the sole-camera auto row renders ONLY when exactly one capture source
 *     exists AND config.source is unset — and the Start handler folds that id into
 *     its payload with NO premature setConfig (rpc spy stays at zero).
 */
import type {
	CapabilitiesMessage,
	ConfigMessage,
	NetifMessage,
	NetworkIngest,
	Pipelines,
	SourcesMessage,
} from "@ceraui/rpc/schemas";
import { Cpu, Server, Volume2 } from "@lucide/svelte";
import { fireEvent, render, within } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";

import GoLiveCard from "./GoLiveCard.svelte";
import type { ConfigRow } from "./StreamSettingsCard.svelte";

// The component owns no RPC, but the sole-camera contract demands PROOF that no
// premature setConfig happens — spy the client and assert it is never touched.
const setConfig = vi.fn();
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));

function capture(id: string, displayName: string) {
	return {
		id,
		pipelineId: `${id}-pipe`,
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: true,
		origin: "capture",
		kind: "hdmi",
		displayName,
		devicePath: `/dev/${id}`,
	};
}

function makeSources(...captures: unknown[]): SourcesMessage {
	return { hardware: "rk3588", sources: captures } as unknown as SourcesMessage;
}

const LIVE_NETIF = {
	eth0: { enabled: true, ip: "10.0.0.2" },
} as unknown as NetifMessage;

interface Handlers {
	onStart: ReturnType<typeof vi.fn>;
	onStop: ReturnType<typeof vi.fn>;
	onOpenSource: ReturnType<typeof vi.fn>;
	onGoNetwork: ReturnType<typeof vi.fn>;
	onOpenServer: ReturnType<typeof vi.fn>;
	onOpenEncoder: ReturnType<typeof vi.fn>;
}

function handlers(): Handlers {
	return {
		onStart: vi.fn(),
		onStop: vi.fn(),
		onOpenSource: vi.fn(),
		onGoNetwork: vi.fn(),
		onOpenServer: vi.fn(),
		onOpenEncoder: vi.fn(),
	};
}

function configRows(h: Handlers): ConfigRow[] {
	return [
		{
			icon: Cpu,
			label: "Encoder",
			value: "1080p60 · 6 Mbps",
			section: "encoder",
			onEdit: h.onOpenEncoder,
			testId: "open-encoder-dialog",
		},
		{
			icon: Volume2,
			label: "Audio",
			value: "AAC · Built-in",
			section: "audio",
			onEdit: vi.fn(),
			testId: "open-audio-dialog",
		},
		{
			icon: Server,
			label: "Server",
			value: "CeraLive Cloud",
			section: "server",
			onEdit: h.onOpenServer,
			testId: "open-server-dialog",
		},
	];
}

interface Overrides {
	config?: ConfigMessage | undefined;
	sources?: SourcesMessage;
	netif?: NetifMessage | undefined;
	isConnected?: boolean;
	isStreaming?: boolean;
	optimismState?: StreamingOptimismState;
	caps?: CapabilitiesMessage | undefined;
	networkIngest?: NetworkIngest | null;
	pipelines?: Pipelines | undefined;
	destinationValidated?: boolean;
	maxBitrate?: number;
}

function renderCard(over: Overrides = {}) {
	const h = handlers();
	const props = {
		config: over.config ?? ({ relay_server: "fra" } as ConfigMessage),
		caps: over.caps,
		sources: over.sources ?? makeSources(capture("cam-1", "HDMI Capture")),
		netif: "netif" in over ? over.netif : LIVE_NETIF,
		isConnected: over.isConnected ?? true,
		networkIngest: over.networkIngest ?? null,
		pipelines: over.pipelines,
		configRows: configRows(h),
		isStreaming: over.isStreaming ?? false,
		optimismState: over.optimismState ?? ("idle" as StreamingOptimismState),
		destinationValidated: over.destinationValidated,
		maxBitrate: over.maxBitrate,
		...h,
	};
	const view = render(GoLiveCard, { props });
	return { ...view, ...h };
}

beforeEach(() => {
	setConfig.mockReset();
});

describe("GoLiveCard — config rows + testids", () => {
	it("renders the three migrated config-row testids (expanded)", () => {
		// A blocked destination keeps the card expanded so the rows are visible.
		const { container } = renderCard({
			config: { source: "cam-1" } as ConfigMessage,
		});
		for (const id of [
			"open-encoder-dialog",
			"open-audio-dialog",
			"open-server-dialog",
		]) {
			expect(
				container.querySelector(`[data-testid="${id}"]`),
				`${id} must render`,
			).not.toBeNull();
		}
	});
});

describe("GoLiveCard — blocked gate", () => {
	it("renders the destination reason + a fix button that opens ServerDialog", async () => {
		const { container, onOpenServer } = renderCard({
			config: { source: "cam-1" } as ConfigMessage, // no relay_server
		});
		const gate = container.querySelector(
			'[data-testid="go-live-gate"][data-gate="destination"]',
		);
		expect(gate?.getAttribute("data-state")).toBe("blocked");
		expect(
			gate?.querySelector('[data-testid="go-live-gate-reason"]'),
			"blocked gate shows a reason",
		).not.toBeNull();

		const fix = gate?.querySelector<HTMLElement>(
			'[data-testid="go-live-gate-fix"][data-fix="openServer"]',
		);
		expect(fix, "destination fix button renders").not.toBeNull();
		await fireEvent.click(fix as HTMLElement);
		expect(onOpenServer).toHaveBeenCalledTimes(1);
	});

	it("disables Start with the blocking reason", () => {
		const { container } = renderCard({
			config: { source: "cam-1" } as ConfigMessage,
		});
		const start = within(container).getByRole("button", {
			name: /start stream/i,
		});
		expect((start as HTMLButtonElement).disabled).toBe(true);
		expect(start.getAttribute("title")).toBe(
			"Configure a server before starting the stream",
		);
	});
});

describe("GoLiveCard — collapse / expand", () => {
	it("collapses to the ready bar when all gates are ok, then re-expands", async () => {
		const { container } = renderCard({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
		});
		// Collapsed: ready bar present, config rows hidden.
		expect(
			container.querySelector('[data-testid="go-live-ready-bar"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="open-encoder-dialog"]'),
		).toBeNull();
		expect(container.querySelector('[data-testid="go-live-card"]')?.getAttribute(
			"data-collapsed",
		)).toBe("true");

		// Expand reveals the rows.
		await fireEvent.click(
			container.querySelector('[data-testid="go-live-expand"]') as HTMLElement,
		);
		expect(
			container.querySelector('[data-testid="open-encoder-dialog"]'),
		).not.toBeNull();
	});

	it("stays expanded when a gate blocks (no ready bar)", () => {
		const { container } = renderCard({
			config: { source: "cam-1" } as ConfigMessage,
		});
		expect(
			container.querySelector('[data-testid="go-live-ready-bar"]'),
		).toBeNull();
		expect(container.querySelector('[data-testid="go-live-card"]')?.getAttribute(
			"data-ready",
		)).toBe("false");
	});
});

describe("GoLiveCard — streaming lock", () => {
	it("locks the config rows with a Lock affordance while streaming", () => {
		const { container } = renderCard({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
			isStreaming: true,
		});
		// Streaming never collapses; edit triggers are replaced by the lock badge.
		expect(
			container.querySelector('[data-testid="open-encoder-dialog"]'),
			"edit trigger is gone while streaming",
		).toBeNull();
		const locks = container.querySelectorAll('[title="Stop stream to change"]');
		expect(locks.length).toBeGreaterThan(0);
		// Stop control is offered.
		expect(
			within(container).getByRole("button", { name: /stop stream/i }),
		).toBeTruthy();
	});
});

describe("GoLiveCard — sole-camera contract", () => {
	it("renders the auto row (source gate ok) with exactly one capture + no config.source, and writes no config", () => {
		const { container } = renderCard({
			// destination blocked → stays expanded so the auto row is visible
			config: {} as ConfigMessage,
			sources: makeSources(capture("cam-1", "RØDE HDMI to USB-C")),
		});
		const auto = container.querySelector(
			'[data-testid="sole-camera-auto"]',
		);
		expect(auto, "auto row renders").not.toBeNull();
		expect(auto?.textContent).toContain("RØDE HDMI to USB-C");
		// The implicit source resolves the source gate to ok.
		expect(
			container
				.querySelector('[data-testid="go-live-gate"][data-gate="source"]')
				?.getAttribute("data-state"),
		).toBe("ok");
		// No premature config write.
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("Change opens the source list", async () => {
		const { container, onOpenSource } = renderCard({
			config: {} as ConfigMessage,
			sources: makeSources(capture("cam-1", "HDMI")),
		});
		await fireEvent.click(
			container.querySelector(
				'[data-testid="sole-camera-change"]',
			) as HTMLElement,
		);
		expect(onOpenSource).toHaveBeenCalledTimes(1);
	});

	it("folds the implicit source id into the Start payload, still no setConfig", async () => {
		const { container, onStart } = renderCard({
			// all other gates green → collapses; Start still folds the implicit id
			config: { relay_server: "fra" } as ConfigMessage,
			sources: makeSources(capture("cam-1", "HDMI")),
		});
		const start = within(container).getByRole("button", {
			name: /start stream/i,
		});
		expect((start as HTMLButtonElement).disabled).toBe(false);
		await fireEvent.click(start);
		expect(onStart).toHaveBeenCalledWith({ source: "cam-1" });
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("hides the auto row once config.source is set", () => {
		const { container } = renderCard({
			config: { source: "cam-1" } as ConfigMessage, // destination blocked → expanded
			sources: makeSources(capture("cam-1", "HDMI")),
		});
		expect(
			container.querySelector('[data-testid="sole-camera-auto"]'),
		).toBeNull();
	});

	it("hides the auto row when two capture sources exist", () => {
		const { container } = renderCard({
			config: {} as ConfigMessage,
			sources: makeSources(capture("cam-1", "HDMI"), capture("cam-2", "USB")),
		});
		expect(
			container.querySelector('[data-testid="sole-camera-auto"]'),
		).toBeNull();
	});
});

describe("GoLiveCard — destination traffic-light + bitrate chip", () => {
	it("shows a green traffic-light only when validated, and a bitrate chip that opens the encoder", async () => {
		const { container, onOpenEncoder } = renderCard({
			config: { source: "cam-1" } as ConfigMessage, // expanded (destination blocked)
			destinationValidated: true,
			maxBitrate: 6000,
		});
		const light = container.querySelector(
			'[data-testid="destination-traffic-light"]',
		);
		expect(light?.getAttribute("data-validated")).toBe("true");

		const chip = container.querySelector<HTMLElement>(
			'[data-testid="bitrate-ceiling-chip"]',
		);
		expect(chip, "bitrate chip renders").not.toBeNull();
		expect(chip?.textContent).toContain("6");
		await fireEvent.click(chip as HTMLElement);
		expect(onOpenEncoder).toHaveBeenCalledTimes(1);
	});

	it("renders a neutral (unvalidated) traffic-light by default", () => {
		const { container } = renderCard({
			config: { source: "cam-1" } as ConfigMessage,
		});
		expect(
			container
				.querySelector('[data-testid="destination-traffic-light"]')
				?.getAttribute("data-validated"),
		).toBe("false");
	});
});
