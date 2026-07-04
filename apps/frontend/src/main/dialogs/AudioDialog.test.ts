// @vitest-environment jsdom
/**
 * AudioDialog — scoped to codec + delay (Task 15).
 *
 * Locks the contracts the plan pins:
 *   • NO audio-source SELECT is rendered — the Source section owns `asrc`;
 *   • a READ-ONLY active-source line renders (device label + change hint), and
 *     federation-tolerantly with `asrc` absent;
 *   • Save persists ONLY `acodec`/`delay` — `asrc` is never in the payload;
 *   • the codec select keeps its disabled-reason `title` affordance.
 */
import type {
	CapabilitiesMessage,
	ConfigMessage,
	Pipeline,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mutable snapshot the mocked subscriptions read from — each test seeds it.
const state = vi.hoisted(() => ({
	pipelines: undefined as unknown,
	capabilities: undefined as unknown,
	config: undefined as unknown,
	audioCodecs: undefined as unknown,
	status: undefined as unknown,
	isStreaming: false,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getPipelines: () => state.pipelines,
	getCapabilities: () => state.capabilities,
	getAudioCodecs: () => state.audioCodecs,
	getIsStreaming: () => state.isStreaming,
	getConfig: () => state.config,
	getStatus: () => state.status,
}));

const setConfig = vi.hoisted(() =>
	vi.fn(async () => ({ success: true, applied: {} }) as unknown),
);
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));

vi.mock("$lib/rpc/dirty-registry.svelte", () => ({
	markPending: vi.fn(),
	onRpcResolved: vi.fn(),
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({
	toast: { error: toastError },
}));

import AudioDialog from "./AudioDialog.svelte";

const AUDIO_PIPELINE: Pipeline = {
	name: "HDMI Capture",
	description: "HDMI capture",
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
};

function seed(overrides: {
	config?: Partial<ConfigMessage>;
	audioSources?: string[];
	isStreaming?: boolean;
	capabilities?: Partial<CapabilitiesMessage>;
} = {}) {
	state.pipelines = { hardware: "rk3588", pipelines: { hdmi: AUDIO_PIPELINE } };
	state.audioCodecs = { aac: { name: "AAC" }, opus: { name: "Opus" } };
	state.capabilities = (overrides.capabilities ?? {}) as CapabilitiesMessage;
	state.isStreaming = overrides.isStreaming ?? false;
	state.status = { asrcs: overrides.audioSources ?? ["Built-in Mic"] };
	state.config = {
		pipeline: "hdmi",
		...overrides.config,
	} as ConfigMessage;
}

// AppDialog picks Dialog vs Sheet via `new MediaQuery(...)` → window.matchMedia,
// absent in jsdom. Stub it to the desktop (Dialog) branch.
beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

afterEach(() => {
	setConfig.mockReset();
	setConfig.mockResolvedValue({ success: true, applied: {} } as unknown);
	toastError.mockClear();
});

describe("AudioDialog — codec + delay only (Task 15)", () => {
	it("renders the read-only active-source line and NO source SELECT", () => {
		seed({ config: { asrc: "Built-in Mic" } });
		render(AudioDialog, {
			props: { open: true, audioSource: "Built-in Mic", audioCodec: "aac" },
		});

		// The read-only active-source line renders…
		const active = document.body.querySelector(
			'[data-testid="audio-source-active"]',
		);
		expect(active).not.toBeNull();
		expect(active?.textContent).toContain("Built-in Mic");

		// …and NO audio-source selector (the old select trigger id) survives.
		expect(document.body.querySelector("#audioSource")).toBeNull();
		// The codec + delay controls DO render.
		expect(document.body.querySelector("#audioCodec")).not.toBeNull();
		expect(document.body.querySelector("#audioDelay")).not.toBeNull();
	});

	it("mounts and shows a calm 'none' line when asrc is absent (federation tolerance)", () => {
		seed({ config: {} });
		render(AudioDialog, { props: { open: true } });

		const active = document.body.querySelector(
			'[data-testid="audio-source-active"]',
		);
		expect(active).not.toBeNull();
		// No throw, no raw id — a translated "no source" fallback renders.
		expect(active?.textContent?.trim().length).toBeGreaterThan(0);
	});

	it("saves ONLY acodec + delay — asrc is never in the payload", async () => {
		seed({ config: { asrc: "Built-in Mic" } });
		render(AudioDialog, {
			props: { open: true, audioSource: "Built-in Mic", audioCodec: "opus" },
		});

		await fireEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(setConfig).toHaveBeenCalledTimes(1);
		const payload = setConfig.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload).toEqual({ acodec: "opus", delay: 0 });
		expect(payload).not.toHaveProperty("asrc");
	});

	it("preserves the codec disabled-reason title affordance when no active source", () => {
		// Audio-supported pipeline, idle, but no active source → codec is disabled
		// with a human-readable reason on the trigger `title`.
		seed({ config: {} });
		render(AudioDialog, { props: { open: true } });

		const codec = document.body.querySelector("#audioCodec");
		expect(codec).not.toBeNull();
		expect(codec?.getAttribute("title")).toBeTruthy();
	});
});
