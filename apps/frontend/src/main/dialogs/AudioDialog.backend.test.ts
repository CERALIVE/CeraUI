// @vitest-environment jsdom
/**
 * The engine audio-backend selector, against the rendered DOM (Todo 20).
 *
 * The pure offer rule is covered by `lib/streaming/audioBackend.test.ts`; this
 * file proves the three things only a mount can prove, and each is a defect:
 *
 *   • an absent capability contributes ZERO nodes (with a positive control, so
 *     the count is a real absence and not a dialog that failed to render);
 *   • a REFUSED write leaves the control where it was AND states why — the
 *     preview-error honesty rule, and the reason `setConfig` resolving with
 *     `{success:false}` is read rather than caught;
 *   • the selection moves on the device's APPLIED echo, so RPC success alone is
 *     structurally unable to move it.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	AudioBackend,
	CapabilitiesMessage,
	ConfigMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	sources: undefined as unknown,
	capabilities: undefined as unknown,
	config: undefined as unknown,
	audioCodecs: undefined as unknown,
	status: undefined as unknown,
	isStreaming: false,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getSources: () => state.sources,
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

vi.mock("svelte-sonner", () => ({ toast: { error: vi.fn() } }));

import AudioDialog from "./AudioDialog.svelte";

const AUDIO_SOURCE: StreamSource = {
	origin: "coarse",
	id: "hdmi",
	pipelineId: "hdmi",
	labelKey: "settings.sources.hdmi",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	defaultResolution: "1080p",
	defaultFramerate: 30,
	audioKind: "selectable",
	available: true,
};

function seed(
	overrides: {
		audio_backends?: CapabilitiesMessage["audio_backends"];
		audio_backend?: AudioBackend;
	} = {},
) {
	state.sources = { hardware: "rk3588", sources: [AUDIO_SOURCE] };
	state.audioCodecs = { aac: { name: "AAC" }, opus: { name: "Opus" } };
	state.capabilities = {
		audio_backends: overrides.audio_backends,
	} as CapabilitiesMessage;
	state.isStreaming = false;
	state.status = { asrcs: ["Built-in Mic"] };
	state.config = {
		pipeline: "hdmi",
		asrc: "Built-in Mic",
		audio_backend: overrides.audio_backend,
	} as ConfigMessage;
}

function open() {
	return render(AudioDialog, {
		props: { open: true, audioSource: "Built-in Mic", audioCodec: "aac" },
	});
}

const section = () =>
	document.body.querySelector('[data-testid="audio-backend"]');
const rung = (backend: AudioBackend) =>
	document.body.querySelector<HTMLButtonElement>(
		`[data-testid="audio-backend-${backend}"]`,
	);
const band = (id: string) =>
	document.body.querySelector(`[data-testid="${id}"]`);

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
	document.body.replaceChildren();
});

describe("AudioDialog — the backend selector is capability-gated", () => {
	it("renders ZERO nodes when the engine stated no audio-backend capability", () => {
		seed({ audio_backends: undefined });
		open();
		expect(section()).toBeNull();
		expect(rung("alsa")).toBeNull();
		expect(rung("pipewire")).toBeNull();
	});

	it("POSITIVE CONTROL: the same dialog DOES render the section once a capability arrives", () => {
		seed({
			audio_backends: { supported: ["alsa", "pipewire"], active: "pipewire" },
		});
		open();
		expect(section()).not.toBeNull();
		expect(rung("alsa")).not.toBeNull();
		expect(rung("pipewire")).not.toBeNull();
	});

	it("offers EXACTLY the advertised set — an unlisted backend gets no rung", () => {
		seed({ audio_backends: { supported: ["alsa"], active: "alsa" } });
		open();
		expect(rung("alsa")).not.toBeNull();
		expect(rung("pipewire")).toBeNull();
	});

	it("renders a single advertised backend DISABLED, with its reason on screen", () => {
		seed({ audio_backends: { supported: ["alsa"], active: "alsa" } });
		open();
		expect(rung("alsa")?.disabled).toBe(true);
		const reason = band("audio-backend-single-reason");
		expect(reason?.textContent?.trim()).toBe(
			m["settings.audioBackend.singleReason"](),
		);
		expect(rung("alsa")?.getAttribute("title")).toMatch(/\S/);
	});

	it("rests on the ENGINE's running arm when nothing was stated — never on `alsa`", () => {
		seed({
			audio_backends: { supported: ["alsa", "pipewire"], active: "pipewire" },
		});
		open();
		expect(rung("pipewire")?.getAttribute("aria-checked")).toBe("true");
		expect(rung("alsa")?.getAttribute("aria-checked")).toBe("false");
		expect(band("audio-backend-active")?.textContent).toContain("PipeWire");
	});

	it("states a stored selection this build no longer advertises, without offering it", () => {
		seed({
			audio_backends: { supported: ["alsa"], active: "alsa" },
			audio_backend: "pipewire",
		});
		open();
		expect(band("audio-backend-stale")?.textContent?.trim()).toBe(
			m["settings.audioBackend.staleSelection"](),
		);
		expect(rung("pipewire")).toBeNull();
	});
});

describe("AudioDialog — selecting a backend", () => {
	it("writes ONLY audio_backend and moves the selection on the device's applied echo", async () => {
		seed({
			audio_backends: { supported: ["alsa", "pipewire"], active: "alsa" },
		});
		setConfig.mockResolvedValue({
			success: true,
			applied: { audio_backend: "pipewire" },
		} as unknown);
		open();

		await fireEvent.click(rung("pipewire") as HTMLElement);
		await tick();
		await tick();

		expect(setConfig).toHaveBeenCalledTimes(1);
		expect(setConfig.mock.calls[0]?.[0]).toEqual({ audio_backend: "pipewire" });
		expect(rung("pipewire")?.getAttribute("aria-checked")).toBe("true");
		// The engine is still on alsa until the next start, and the dialog says so.
		expect(band("audio-backend-next-start")?.textContent?.trim()).toBe(
			m["settings.audioBackend.nextStart"](),
		);
		expect(band("audio-backend-error")).toBeNull();
	});

	it("dispatches NOTHING for the rung already selected", async () => {
		seed({
			audio_backends: { supported: ["alsa", "pipewire"], active: "pipewire" },
		});
		open();

		const selected = rung("pipewire");
		expect(selected?.disabled).toBe(true);
		await fireEvent.click(selected as HTMLElement);
		await tick();

		expect(setConfig).not.toHaveBeenCalled();
	});
});

describe("AudioDialog — a refused backend is stated, never swallowed", () => {
	it("renders the typed refusal as an explicit alert band and leaves the selection put", async () => {
		seed({
			audio_backends: { supported: ["alsa", "pipewire"], active: "alsa" },
		});
		setConfig.mockResolvedValue({
			success: false,
			error: "audio_backend_unsupported",
			applied: {},
		} as unknown);
		open();

		await fireEvent.click(rung("pipewire") as HTMLElement);
		await tick();
		await tick();

		const error = band("audio-backend-error");
		expect(error).not.toBeNull();
		expect(error?.getAttribute("role")).toBe("alert");
		expect(error?.textContent).toContain(
			m["settings.audioBackend.errorUnsupported"](),
		);
		// PESSIMISTIC: a resolved refusal is structurally unable to move the control.
		expect(rung("alsa")?.getAttribute("aria-checked")).toBe("true");
		expect(rung("pipewire")?.getAttribute("aria-checked")).toBe("false");
		// And nothing is left spinning — the band IS the end of the attempt.
		expect(band("audio-backend-applying")).toBeNull();
	});

	it("renders the generic failure copy for a thrown transport fault", async () => {
		seed({
			audio_backends: { supported: ["alsa", "pipewire"], active: "alsa" },
		});
		setConfig.mockRejectedValue(new Error("socket closed"));
		open();

		await fireEvent.click(rung("pipewire") as HTMLElement);
		await tick();
		await tick();

		expect(band("audio-backend-error")?.textContent).toContain(
			m["notifications.saveFailed"](),
		);
		expect(rung("alsa")?.getAttribute("aria-checked")).toBe("true");
		expect(band("audio-backend-applying")).toBeNull();
	});

	it("clears a previous refusal when the next attempt is dispatched", async () => {
		seed({
			audio_backends: { supported: ["alsa", "pipewire"], active: "alsa" },
		});
		setConfig.mockResolvedValue({
			success: false,
			error: "audio_backend_unsupported",
			applied: {},
		} as unknown);
		open();

		await fireEvent.click(rung("pipewire") as HTMLElement);
		await tick();
		await tick();
		expect(band("audio-backend-error")).not.toBeNull();

		setConfig.mockResolvedValue({
			success: true,
			applied: { audio_backend: "pipewire" },
		} as unknown);
		await fireEvent.click(rung("pipewire") as HTMLElement);
		await tick();
		await tick();

		expect(band("audio-backend-error")).toBeNull();
		expect(rung("pipewire")?.getAttribute("aria-checked")).toBe("true");
	});
});

describe("AudioDialog — the federated mount reads the host's snapshot", () => {
	/** A hosted bundle: no `initSubscriptions()`, so every getter is empty. */
	function seedHostedBundle() {
		seed({ audio_backends: undefined });
		state.sources = undefined;
		state.config = undefined;
		state.status = undefined;
		state.audioCodecs = undefined;
	}

	it("renders the selector with NO `sources` subscription — the pipeline gate has no evidence to spend", () => {
		// The regression: the gate resolved `no-pipeline` and swallowed the whole
		// dialog body, so the ADDITIVE `capabilities` option could never reach the
		// screen a host mounts. Save was enabled the entire time.
		seedHostedBundle();
		render(AudioDialog, {
			props: {
				open: true,
				audioSource: "Built-in Mic",
				audioCodec: "aac",
				hostAdapter: { setConfig: vi.fn(), validateRelay: vi.fn() } as never,
				capabilities: {
					audio_backends: { supported: ["alsa", "pipewire"], active: "alsa" },
				} as CapabilitiesMessage,
			},
		});

		expect(section()).not.toBeNull();
		expect(rung("alsa")).not.toBeNull();
		expect(rung("pipewire")).not.toBeNull();
		expect(document.body.textContent).not.toContain(
			m["settings.selectPipelineFirst"](),
		);
	});

	it("MIRROR CONTROL: a DEVICE mount with no pipeline still gates the whole dialog", () => {
		// The fail-open is the HOSTED branch and nothing else — on a device the
		// pipeline gate has real evidence, so it keeps deciding.
		seedHostedBundle();
		state.capabilities = {
			audio_backends: { supported: ["alsa", "pipewire"], active: "alsa" },
		} as CapabilitiesMessage;
		render(AudioDialog, {
			props: { open: true, audioSource: "Built-in Mic", audioCodec: "aac" },
		});

		expect(document.body.textContent).toContain(
			m["settings.selectPipelineFirst"](),
		);
		expect(section()).toBeNull();
	});

	it("offers the host's capability even when the device subscription is empty", () => {
		seed({ audio_backends: undefined });
		render(AudioDialog, {
			props: {
				open: true,
				audioSource: "Built-in Mic",
				audioCodec: "aac",
				capabilities: {
					audio_backends: { supported: ["alsa", "pipewire"], active: "alsa" },
				} as CapabilitiesMessage,
				audioBackend: "pipewire",
			},
		});

		expect(rung("pipewire")?.getAttribute("aria-checked")).toBe("true");
		expect(band("audio-backend-active")?.textContent).toContain("ALSA");
	});

	it("routes the write through the host adapter, not the device RPC", async () => {
		seed({ audio_backends: undefined });
		const hostSetConfig = vi.fn(async () => ({
			success: true,
			applied: { audio_backend: "alsa" },
		}));
		render(AudioDialog, {
			props: {
				open: true,
				audioSource: "Built-in Mic",
				audioCodec: "aac",
				hostAdapter: {
					setConfig: hostSetConfig,
					validateRelay: vi.fn(),
				} as never,
				capabilities: {
					audio_backends: {
						supported: ["alsa", "pipewire"],
						active: "pipewire",
					},
				} as CapabilitiesMessage,
			},
		});

		await fireEvent.click(rung("alsa") as HTMLElement);
		await tick();
		await tick();

		expect(hostSetConfig).toHaveBeenCalledWith({ audio_backend: "alsa" });
		expect(setConfig).not.toHaveBeenCalled();
		expect(rung("alsa")?.getAttribute("aria-checked")).toBe("true");
	});
});
