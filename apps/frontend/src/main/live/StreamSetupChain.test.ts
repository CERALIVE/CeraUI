// @vitest-environment jsdom
/**
 * StreamSetupChain — the merged "Stream setup" card (Task T9).
 *
 * Locks the contracts the plan pins:
 *   • THREE rows in signal order (encoder → destination → network), each
 *     `data-testid="setup-row"` with `data-row` + `data-state`;
 *   • a blocked source gate renders the Encoder row `data-state="blocked"` + the
 *     reason text, and Start is disabled with the matching reason;
 *   • the two migrated dialog testids (open-encoder/open-server) are present;
 *   • Audio is NOT a setup-chain row (T11) — the Source card owns the audio
 *     surface, so no `data-row="audio"` and no `open-audio-dialog` render here;
 *   • the sole-camera auto row renders ONLY when exactly one capture source exists
 *     AND config.source is unset — folding that id into the Start payload with NO
 *     premature setConfig (rpc spy stays at zero);
 *   • while streaming every row locks (Lock affordance, no edit trigger);
 *   • NONE of the retired collapse/gate testids exist (no ready bar — all four
 *     rows are ALWAYS fully rendered).
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
import type { ConfigRow } from "./StreamSettingsCard.svelte";
import StreamSetupChain from "./StreamSetupChain.svelte";

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

interface RowOptions {
	encoderWarn?: boolean;
	audioWarn?: boolean;
}

function configRows(h: Handlers, opts: RowOptions = {}): ConfigRow[] {
	return [
		{
			icon: Cpu,
			label: "Encoder",
			value: "1080p60 · 6 Mbps",
			section: "encoder",
			onEdit: h.onOpenEncoder,
			testId: "open-encoder-dialog",
			warn: opts.encoderWarn,
		},
		{
			icon: Volume2,
			label: "Audio",
			value: "AAC · Built-in",
			section: "audio",
			onEdit: vi.fn(),
			testId: "open-audio-dialog",
			warn: opts.audioWarn,
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
	rowOptions?: RowOptions;
}

function renderChain(over: Overrides = {}) {
	const h = handlers();
	const props = {
		config: over.config ?? ({ relay_server: "fra" } as ConfigMessage),
		caps: over.caps,
		sources: over.sources ?? makeSources(capture("cam-1", "HDMI Capture")),
		netif: "netif" in over ? over.netif : LIVE_NETIF,
		isConnected: over.isConnected ?? true,
		networkIngest: over.networkIngest ?? null,
		pipelines: over.pipelines,
		configRows: configRows(h, over.rowOptions),
		isStreaming: over.isStreaming ?? false,
		optimismState: over.optimismState ?? ("idle" as StreamingOptimismState),
		destinationValidated: over.destinationValidated,
		maxBitrate: over.maxBitrate,
		...h,
	};
	const view = render(StreamSetupChain, { props });
	return { ...view, ...h };
}

function rowKeys(container: HTMLElement): string[] {
	return Array.from(
		container.querySelectorAll('[data-testid="setup-row"]'),
	).map((row) => row.getAttribute("data-row") ?? "");
}

function rowFor(container: HTMLElement, key: string): HTMLElement | null {
	return container.querySelector<HTMLElement>(
		`[data-testid="setup-row"][data-row="${key}"]`,
	);
}

beforeEach(() => {
	setConfig.mockReset();
});

describe("StreamSetupChain — three rows in signal order", () => {
	it("renders exactly three rows: encoder → destination → network (no audio)", () => {
		const { container } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
		});
		expect(rowKeys(container)).toEqual(["encoder", "destination", "network"]);
	});

	it("renders the two migrated dialog testids; audio is NOT a setup row (T11)", () => {
		const { container } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
		});
		for (const id of ["open-encoder-dialog", "open-server-dialog"]) {
			expect(
				container.querySelector(`[data-testid="${id}"]`),
				`${id} must render`,
			).not.toBeNull();
		}
		// Source card is the ONE audio surface — no audio row/affordance here (T11).
		expect(rowFor(container, "audio")).toBeNull();
		expect(
			container.querySelector('[data-testid="open-audio-dialog"]'),
		).toBeNull();
	});

	it("never collapses when every gate is green: all three rows stay rendered, one Start control", () => {
		// All gates green — the retired GoLiveCard would have collapsed to a ready bar
		// here; StreamSetupChain keeps every row fully rendered with a single Start
		// control at the foot (no ready-bar / expand / collapse affordance exists).
		const { container } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
		});
		expect(rowKeys(container)).toHaveLength(3);
		expect(
			within(container).getAllByRole("button", { name: /start stream/i }),
		).toHaveLength(1);
	});
});

describe("StreamSetupChain — encoder row (source gate)", () => {
	it("blocked source gate → encoder row data-state='blocked' + reason text, Start disabled", () => {
		const { container } = renderChain({
			// no source AND no capture → source gate blocked
			config: { relay_server: "fra" } as ConfigMessage,
			sources: makeSources(),
		});
		const encoder = rowFor(container, "encoder");
		expect(encoder?.getAttribute("data-state")).toBe("blocked");
		expect(
			encoder?.querySelector('[data-testid="setup-row-reason"]'),
			"blocked encoder row shows a reason",
		).not.toBeNull();

		const start = within(container).getByRole("button", {
			name: /start stream/i,
		});
		expect((start as HTMLButtonElement).disabled).toBe(true);
		expect(start.getAttribute("title")).toBe(
			"Select a video source before starting the stream",
		);
	});

	it("recognized source but pipelineNeedsReconfigure → encoder row warn, Start still enabled", () => {
		const { container } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
			rowOptions: { encoderWarn: true },
		});
		expect(rowFor(container, "encoder")?.getAttribute("data-state")).toBe(
			"warn",
		);
		const start = within(container).getByRole("button", {
			name: /start stream/i,
		});
		expect((start as HTMLButtonElement).disabled).toBe(false);
	});

	it("shows the bitrate-ceiling chip and opens the encoder from it", async () => {
		const { container, onOpenEncoder } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
			maxBitrate: 6000,
		});
		const chip = container.querySelector<HTMLElement>(
			'[data-testid="bitrate-ceiling-chip"]',
		);
		expect(chip, "bitrate chip renders").not.toBeNull();
		expect(chip?.textContent).toContain("6");
		await fireEvent.click(chip as HTMLElement);
		expect(onOpenEncoder).toHaveBeenCalledTimes(1);
	});
});

describe("StreamSetupChain — audio is not a setup row (T11)", () => {
	it("ignores a stray audio config row and never blocks Start on it", () => {
		const { container } = renderChain({
			// A warn-flagged audio config row is still passed in configRows; the
			// setup chain must ignore it entirely (audio moved to the Source card).
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
			rowOptions: { audioWarn: true },
		});
		expect(rowFor(container, "audio")).toBeNull();
		const start = within(container).getByRole("button", {
			name: /start stream/i,
		});
		expect((start as HTMLButtonElement).disabled).toBe(false);
		expect(start.getAttribute("title")).toBeNull();
	});
});

describe("StreamSetupChain — destination row", () => {
	it("blocked destination gate → destination row blocked + reason, opens ServerDialog", async () => {
		const { container, onOpenServer } = renderChain({
			config: { source: "cam-1" } as ConfigMessage, // no relay_server
		});
		const dest = rowFor(container, "destination");
		expect(dest?.getAttribute("data-state")).toBe("blocked");
		expect(
			dest?.querySelector('[data-testid="setup-row-reason"]'),
		).not.toBeNull();
		await fireEvent.click(
			container.querySelector(
				'[data-testid="open-server-dialog"]',
			) as HTMLElement,
		);
		expect(onOpenServer).toHaveBeenCalledTimes(1);
	});

	it("shows a green traffic-light only when validated", () => {
		const { container } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
			destinationValidated: true,
		});
		expect(
			container
				.querySelector('[data-testid="destination-traffic-light"]')
				?.getAttribute("data-validated"),
		).toBe("true");
	});

	it("renders a neutral (unvalidated) traffic-light by default", () => {
		const { container } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
		});
		expect(
			container
				.querySelector('[data-testid="destination-traffic-light"]')
				?.getAttribute("data-validated"),
		).toBe("false");
	});
});

describe("StreamSetupChain — network row", () => {
	it("blocked network gate → network row blocked + a goNetwork fix that navigates", async () => {
		const { container, onGoNetwork } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
			netif: undefined, // no enabled+IP interface → network gate blocked
		});
		const network = rowFor(container, "network");
		expect(network?.getAttribute("data-state")).toBe("blocked");
		const fix = container.querySelector<HTMLElement>(
			'[data-testid="setup-row-fix"][data-fix="goNetwork"]',
		);
		expect(fix, "network fix button renders").not.toBeNull();
		await fireEvent.click(fix as HTMLElement);
		expect(onGoNetwork).toHaveBeenCalledTimes(1);
	});

	it("an enabled+IP interface → network row ok with a link-count summary", () => {
		const { container } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
		});
		const network = rowFor(container, "network");
		expect(network?.getAttribute("data-state")).toBe("ok");
		expect(network?.textContent).toContain("1");
	});
});

describe("StreamSetupChain — streaming lock", () => {
	it("locks every config row with a Lock affordance while streaming", () => {
		const { container } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
			isStreaming: true,
		});
		// Edit triggers are replaced by the lock badge for the lockable sections.
		for (const id of ["open-encoder-dialog", "open-server-dialog"]) {
			expect(
				container.querySelector(`[data-testid="${id}"]`),
				`${id} edit trigger is gone while streaming`,
			).toBeNull();
		}
		const locks = container.querySelectorAll('[title="Stop stream to change"]');
		expect(locks.length).toBeGreaterThan(0);
		// All three rows are still rendered while streaming (no collapse).
		expect(rowKeys(container)).toHaveLength(3);
		// Stop control is offered.
		expect(
			within(container).getByRole("button", { name: /stop stream/i }),
		).toBeTruthy();
	});
});

describe("StreamSetupChain — sole-camera contract", () => {
	it("renders the auto row (source gate ok) with exactly one capture + no config.source, writing no config", () => {
		const { container } = renderChain({
			config: { relay_server: "fra" } as ConfigMessage,
			sources: makeSources(capture("cam-1", "RØDE HDMI to USB-C")),
		});
		const auto = container.querySelector('[data-testid="sole-camera-auto"]');
		expect(auto, "auto row renders").not.toBeNull();
		expect(auto?.textContent).toContain("RØDE HDMI to USB-C");
		// The implicit source resolves the encoder (source) row to ok.
		expect(rowFor(container, "encoder")?.getAttribute("data-state")).toBe("ok");
		// No premature config write.
		expect(setConfig).not.toHaveBeenCalled();
	});

	it("Change opens the source list", async () => {
		const { container, onOpenSource } = renderChain({
			config: { relay_server: "fra" } as ConfigMessage,
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
		const { container, onStart } = renderChain({
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
		const { container } = renderChain({
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
			sources: makeSources(capture("cam-1", "HDMI")),
		});
		expect(
			container.querySelector('[data-testid="sole-camera-auto"]'),
		).toBeNull();
	});

	it("hides the auto row when two capture sources exist", () => {
		const { container } = renderChain({
			config: { relay_server: "fra" } as ConfigMessage,
			sources: makeSources(capture("cam-1", "HDMI"), capture("cam-2", "USB")),
		});
		expect(
			container.querySelector('[data-testid="sole-camera-auto"]'),
		).toBeNull();
	});
});
