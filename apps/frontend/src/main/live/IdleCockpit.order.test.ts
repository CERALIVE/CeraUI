// @vitest-environment jsdom
/**
 * IdleCockpit — the idle order of the Live screen contract.
 *
 *   program-desk (holding preview-disclosure) → source-section (holding, after
 *   its rows, audio-card) → stream-setup-chain (holding output-card,
 *   connections-card, live-bar in that order) → live-roadmap.
 *
 * SourceSection and StreamSetupChain mount for real so the cards they host are
 * part of the asserted order; PreviewCanvas / PreviewEncodeControl / ComingSoon
 * are Noop, and the RPC client, QR helper and subscription feed are stubbed.
 */
import type {
	ConfigMessage,
	NetifMessage,
	SourcesMessage,
} from "@ceraui/rpc/schemas";
import { Cpu, Server } from "@lucide/svelte";
import { cleanup, render } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/components/preview/PreviewCanvas.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("./PreviewEncodeControl.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/ComingSoon.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => ""),
}));
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig: vi.fn() } },
	rpcClient: {},
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getAudioLevel: () => undefined,
	getCapabilities: () => undefined,
	getConfig: () => undefined,
}));

import IdleCockpit from "./IdleCockpit.svelte";

const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

afterEach(() => {
	cleanup();
});

// One selected capture with audio: the Source card renders its audio block.
const SOURCES = {
	hardware: "rk3588",
	sources: [
		{
			origin: "capture",
			id: "cam",
			pipelineId: "hdmi",
			kind: "hdmi",
			displayName: "HDMI",
			devicePath: "/dev/video0",
			modes: [],
			supportsAudio: true,
			supportsResolutionOverride: true,
			supportsFramerateOverride: true,
			audioKind: "selectable",
			available: true,
		},
	],
} as unknown as SourcesMessage;

function props(): ComponentProps<typeof IdleCockpit> {
	const noop = () => {};
	return {
		config: {
			source: "cam",
			relay_server: "fra",
			max_br: 6000,
		} as unknown as ConfigMessage,
		caps: undefined,
		sources: SOURCES,
		netif: {
			eth0: { enabled: true, ip: "10.0.0.2" },
		} as unknown as NetifMessage,
		isConnected: true,
		networkIngest: null,
		pipelines: undefined,
		relays: undefined,
		managedSlots: undefined,
		configRows: [
			{
				icon: Cpu,
				label: "Encoder",
				value: "1080p60",
				section: "encoder",
				onEdit: noop,
				testId: "open-encoder-dialog",
			},
			{
				icon: Server,
				label: "Server",
				value: "fra",
				section: "server",
				onEdit: noop,
				testId: "open-server-dialog",
			},
		],
		isStreaming: false,
		optimismState: "idle",
		onStart: noop,
		onStop: noop,
		onOpenSource: noop,
		onGoNetwork: noop,
		onOpenEncoder: noop,
		activeInput: undefined,
		switchingInput: undefined,
		onSwitch: noop,
		audioSources: [],
		audioSourceList: [],
		selectedAudioSource: undefined,
		onSelectAudioSource: noop,
		onAudioSelectionApplied: noop,
		audioStatus: undefined,
		onOpenAudioDialog: noop,
		selectedPipeline: undefined,
		capabilities: undefined,
		activeEncode: null,
	};
}

function byTestId(root: ParentNode, id: string): HTMLElement {
	const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	expect(el, `${id} renders`).not.toBeNull();
	return el as HTMLElement;
}

function expectInOrder(ids: readonly string[], root: ParentNode): void {
	const elements = ids.map((id) => byTestId(root, id));
	for (let i = 0; i < elements.length - 1; i++) {
		const current = elements[i] as HTMLElement;
		const next = elements[i + 1] as HTMLElement;
		expect(
			current.compareDocumentPosition(next) & FOLLOWING,
			`${ids[i]} precedes ${ids[i + 1]}`,
		).toBeTruthy();
	}
}

describe("IdleCockpit — program desk, cards and Live bar", () => {
	it("orders program-desk, source-section, stream-setup-chain, live-roadmap by DOM position", () => {
		const { container } = render(IdleCockpit, { props: props() });
		const cockpit = byTestId(container, "idle-cockpit");

		expectInOrder(
			["program-desk", "source-section", "stream-setup-chain", "live-roadmap"],
			cockpit,
		);
	});

	it("the desk holds the preview, and the Source card ends with its audio card", () => {
		const { container } = render(IdleCockpit, { props: props() });

		byTestId(byTestId(container, "program-desk"), "preview-disclosure");

		const section = byTestId(container, "source-section");
		const audioCard = byTestId(section, "audio-card");
		byTestId(audioCard, "source-audio");
		expectInOrder(["source-list", "audio-card"], section);
	});

	it("the setup chain holds output-card, connections-card, live-bar in that order", () => {
		const { container } = render(IdleCockpit, { props: props() });
		const chain = byTestId(container, "stream-setup-chain");

		expectInOrder(["output-card", "connections-card", "live-bar"], chain);

		const output = byTestId(chain, "output-card");
		byTestId(output, "open-encoder-dialog");
		byTestId(output, "open-server-dialog");
		expect(
			byTestId(chain, "connections-card").querySelector('[data-row="network"]'),
			"the network row sits in connections-card",
		).not.toBeNull();
	});
});
