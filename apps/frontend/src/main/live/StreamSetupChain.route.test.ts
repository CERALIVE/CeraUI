// @vitest-environment jsdom
import type { ConfigMessage, SourcesMessage } from "@ceraui/rpc/schemas";
import { Cpu, Server } from "@lucide/svelte";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";
import type { ConfigRow } from "./StreamSettingsCard.svelte";
import StreamSetupChain from "./StreamSetupChain.svelte";

vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig: vi.fn() } },
	rpcClient: {},
}));

const SOURCES = {
	hardware: "rk3588",
	sources: [
		{
			id: "cam-1",
			pipelineId: "hdmi",
			modes: [],
			supportsAudio: false,
			supportsResolutionOverride: false,
			supportsFramerateOverride: false,
			audioKind: "none",
			available: true,
			origin: "capture",
			kind: "hdmi",
			displayName: "HDMI Capture",
			devicePath: "/dev/video0",
		},
	],
} as unknown as SourcesMessage;

function rows(route?: ConfigRow["route"]): ConfigRow[] {
	return [
		{
			icon: Cpu,
			label: "Encoder",
			value: "HDMI Capture · 6 Mbps",
			section: "encoder",
			onEdit: vi.fn(),
			testId: "open-encoder-dialog",
			...(route ? { route } : {}),
		},
		{
			icon: Server,
			label: "Server",
			value: "CeraLive Cloud",
			section: "server",
			onEdit: vi.fn(),
			testId: "open-server-dialog",
		},
	];
}

function renderChain(configRows: ConfigRow[]) {
	return render(StreamSetupChain, {
		props: {
			config: { source: "cam-1", relay_server: "fra" } as ConfigMessage,
			caps: undefined,
			sources: SOURCES,
			netif: undefined,
			isConnected: true,
			networkIngest: null,
			pipelines: undefined,
			relays: undefined,
			managedSlots: undefined,
			configRows,
			isStreaming: false,
			optimismState: "idle" as StreamingOptimismState,
			onStart: vi.fn(),
			onStop: vi.fn(),
			onOpenSource: vi.fn(),
			onGoNetwork: vi.fn(),
			onOpenEncoder: vi.fn(),
		},
	});
}

describe("StreamSetupChain — the encoder row carries the route line", () => {
	it("renders the encoder row's route under its summary, keyed by outcome", () => {
		const { container } = renderChain(
			rows({ outcome: "converted", text: "route line copy" }),
		);
		const encoder = container.querySelector(
			'[data-testid="setup-row"][data-row="encoder"]',
		);
		const route = encoder?.querySelector("[data-route]");
		expect(route?.getAttribute("data-route")).toBe("converted");
		expect(route?.textContent?.trim()).toBe("route line copy");
		expect(
			container.querySelector(
				'[data-testid="setup-row"][data-row="destination"] [data-route]',
			),
		).toBeNull();
	});

	it("renders no route line when the row has none", () => {
		const { container } = renderChain(rows());
		expect(container.querySelector("[data-route]")).toBeNull();
	});
});
