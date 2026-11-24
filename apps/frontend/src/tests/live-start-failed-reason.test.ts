// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VIEW_LOGS_TOAST_CLASS } from "../lib/device-logs/view-logs";
import { ConnectionResetError } from "../lib/rpc/client";
import { NotSentError } from "../lib/rpc/rpc-error";
import { runStartWatchdog } from "../lib/rpc/streaming-start-watchdog";

import { en } from "./helpers/catalog";

const state = vi.hoisted(() => ({
	optimismState: "idle" as "idle" | "starting" | "stopping",
	startOptimism: vi.fn(),
	revertOptimism: vi.fn(),
	stopReason: undefined as string | undefined,
	failure: undefined as
		| {
				class: string;
				phase: string;
				retriable: boolean;
				attemptId: string;
				message?: string;
				captureCause?: string;
		  }
		| undefined,
	// The idle Live bar's readiness inputs: ready by default (a capture source,
	// a server and one usable link), so Try again passes the bar's gate.
	config: {
		relay_server: "fra",
		max_br: 6000,
		pipeline: "hdmi",
		source: "cam-1",
	} as Record<string, unknown>,
	netif: { eth0: { enabled: true, ip: "192.0.2.10" } } as Record<
		string,
		unknown
	>,
	status: { stream_lifecycle: "idle" } as Record<string, unknown>,
	// The optimism store's attempt generation (each Start dispatch takes a new one).
	generation: 1,
}));
const toastError = vi.hoisted(() => vi.fn());
const reboot = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
const startStreaming = vi.hoisted(() => vi.fn());
const deliveredFailure = writable<typeof state.failure>(undefined);
const failureReceipt = fromStore(deliveredFailure);

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, dismiss: vi.fn() },
}));
vi.mock("$lib/stores/navigation-lazy", () => ({
	navigateToDestination: navigate,
}));

vi.mock("$lib/helpers/SystemHelper", () => ({
	startStreaming: async (readmit: () => unknown, onSent?: () => void) => {
		const config = readmit();
		if (config === undefined) return undefined;
		const result = await startStreaming(config);
		onSent?.();
		return result;
	},
	stopStreaming: vi.fn(),
	reboot,
}));

vi.mock("$lib/streaming/sources-view-model", () => ({
	pipelinesFromSources: () => ({ hdmi: {} }),
}));

vi.mock("$lib/config", () => ({
	navElements: { network: { label: "Network" } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getStartConfigGeneration: () => 0,
	getConfig: () => state.config,
	getIsStreaming: () => false,
	getSensors: () => ({}),
	getLinkTelemetry: () => null,
	getAudioLevel: () => undefined,
	getDevices: () => [],
	getActiveInput: () => undefined,
	getConnectionState: () => "connected",
	getIsConnected: () => true,
	getCapabilities: () => ({ encoder: {} }),
	getConfigChange: () => undefined,
	getNetif: () => state.netif,
	getRelays: () => undefined,
	getManagedIngestAccounts: () => [],
	getStatus: () => state.status,
	getPipelines: () => ({ pipelines: {} }),
	getSources: () => ({
		sources: [
			{
				id: "cam-1",
				displayName: "Camera",
				available: true,
				origin: "capture",
				pipelineId: "hdmi",
			},
		],
	}),
}));

vi.mock("$lib/rpc/streaming-optimism.svelte", () => ({
	getStreamingOptimismState: () => state.optimismState,
	getStreamingStopReason: () => state.stopReason,
	getStreamingStartFailure: () => failureReceipt.current ?? state.failure,
	getStreamingAttemptGeneration: () => state.generation,
	getStopStuckBannerVisible: () => false,
	startStreamingOptimism: state.startOptimism,
	stopStreamingOptimism: vi.fn(),
	reconcileStreamingOptimism: vi.fn(),
	revertStreamingOptimism: state.revertOptimism,
	revertStreamingOptimismFailure: deliveredFailureSet,
	retryStopStreaming: vi.fn(),
}));

function deliveredFailureSet(failure: typeof state.failure) {
	state.optimismState = "idle";
	deliveredFailure.set(failure);
}

vi.mock("$main/live/IdleCockpit.svelte", async () => ({
	default: (await import("./fixtures/IdleCockpitStartStub.svelte")).default,
}));
vi.mock("$main/live/LiveCockpit.svelte", async () => ({
	default: (await import("./fixtures/LiveCockpitStub.svelte")).default,
}));
vi.mock("$main/live/LiveHeader.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/live/CapabilityTierBanner.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/ServerDialog.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/PowerDialog.svelte", async () => ({
	default: (await import("./fixtures/PowerDialogOpenProbe.svelte")).default,
}));
vi.mock("$main/dialogs/AudioDialog.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));
vi.mock("$main/dialogs/EncoderDialog.svelte", async () => ({
	default: (await import("./fixtures/Noop.svelte")).default,
}));

import {
	clearRequestedDialog,
	getRequestedDialog,
	getRequestedDialogContext,
} from "$lib/stores/dialog-request.svelte";

import LiveView from "../main/LiveView.svelte";
import StartRefusalActions from "../main/live/StartRefusalActions.svelte";

const startFailed = en.live.startFailed as Readonly<Record<string, string>>;

// A suffix that sends the operator to System Logs brings the action with it.
const VIEW_LOGS = {
	action: { label: en.notifications.viewLogs, onClick: expect.any(Function) },
	class: VIEW_LOGS_TOAST_CLASS,
};

// A refusal with a decided next step: that step is the button, View logs stays
// beside it for a helper, and the toast stays up long enough to reach it.
function nextStep(label: string) {
	return expect.objectContaining({
		description: StartRefusalActions,
		componentProps: expect.objectContaining({
			primary: { label, activate: expect.any(Function) },
			logs: expect.any(Function),
			close: expect.any(Function),
		}),
		duration: Number.POSITIVE_INFINITY,
	});
}

afterEach(() => {
	cleanup();
	state.optimismState = "idle";
	state.startOptimism.mockReset();
	state.revertOptimism.mockReset();
	state.stopReason = undefined;
	state.failure = undefined;
	deliveredFailure.set(undefined);
	toastError.mockReset();
	startStreaming.mockReset();
	clearRequestedDialog();
	reboot.mockReset();
	navigate.mockReset();
	state.netif = { eth0: { enabled: true, ip: "192.0.2.10" } };
	state.config.source = "cam-1";
	state.status = { stream_lifecycle: "idle" };
	state.generation = 1;
	vi.restoreAllMocks();
});

describe("LiveView start-failure output", () => {
	it("keeps starting after ConnectionResetError until the watchdog reconciles", async () => {
		state.startOptimism.mockImplementation(() => {
			state.optimismState = "starting";
		});
		state.revertOptimism.mockImplementation(() => {
			state.optimismState = "idle";
		});
		startStreaming.mockRejectedValueOnce(
			new ConnectionResetError(["streaming", "start"]),
		);

		const view = render(LiveView);
		await fireEvent.click(view.getByTestId("start-stream"));
		await waitFor(() => expect(startStreaming).toHaveBeenCalledTimes(1));

		expect(state.optimismState).toBe("starting");
		expect(state.revertOptimism).not.toHaveBeenCalled();

		await runStartWatchdog({
			pullStatus: async () => true,
			reconcile: (isStreaming: boolean) => {
				if (isStreaming) state.optimismState = "idle";
			},
			revert: state.revertOptimism,
		});
		expect(state.optimismState).toBe("idle");
	});

	it.each([
		"audio_source_probe_failed",
		"audio_codec_unsupported_transport",
		"source_lost",
		"source_unavailable",
	])("shows the localized reason for %s", async (reason) => {
		state.stopReason = reason;

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(startFailed[reason]);
		expect(toastError.mock.calls[0]).toHaveLength(1);
		expect(startFailed[reason]).not.toBe(startFailed.generic);
	});

	it("shows the generic message for an unknown reason", async () => {
		state.stopReason = "unknown_engine_failure";

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(startFailed.generic);
	});
});

const startFailure = en.live.startFailure;

describe("LiveView typed start-failure rendering (Todo 29)", () => {
	it("an engine refusal ends in Try again, not in System Logs", async () => {
		state.failure = {
			class: "engine_unavailable",
			phase: "connect",
			retriable: true,
			attemptId: "att_a",
		};

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(
			`${startFailure.class.engine_unavailable} ${startFailure.next.tryAgain}`,
			nextStep(startFailure.action.tryAgain),
		);
	});

	it("opens System Logs on Raw logs at the moment the failure was shown", async () => {
		state.failure = {
			class: "engine_unavailable",
			phase: "connect",
			retriable: true,
			attemptId: "att_logs",
		};
		const before = Date.now();

		render(LiveView);
		await tick();
		const after = Date.now();
		const actions = render(StartRefusalActions, {
			props: toastError.mock.calls[0]?.[1]?.componentProps,
		});
		await fireEvent.click(
			actions.getByRole("button", { name: en.notifications.viewLogs }),
		);

		expect(getRequestedDialog()).toBe("logs");
		const context = getRequestedDialogContext();
		expect(context?.tab).toBe("raw");
		expect(context?.at).toBeGreaterThanOrEqual(before);
		expect(context?.at).toBeLessThanOrEqual(after);
	});

	it("an invalid start ends in Open stream setup", async () => {
		state.failure = {
			class: "start_invalid",
			phase: "params",
			retriable: false,
			attemptId: "att_b",
		};

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(
			`${startFailure.class.start_invalid} ${startFailure.next.openSetup}`,
			nextStep(startFailure.action.openSetup),
		);
	});

	it("a full engine attempt pool names the refusal without offering Retry", async () => {
		state.failure = {
			class: "attempt_capacity",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_capacity",
		};

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenCalledWith(
			en.notifications.streamStartAttemptCapacity,
			expect.not.objectContaining({ componentProps: expect.anything() }),
		);
	});

	it("prefers the typed failure over a legacy stopReason (single toast)", async () => {
		state.failure = {
			class: "engine_internal",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_c",
		};
		state.stopReason = "source_lost";

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError).toHaveBeenCalledWith(
			`${startFailure.class.engine_internal} ${startFailure.next.tryAgain}`,
			nextStep(startFailure.action.tryAgain),
		);
	});

	// `capture_source_unavailable` is the one class whose copy is keyed by cause:
	// the class names the subsystem, the cause names the operator's next move, so
	// rendering the class alone would be a band nobody can act on.
	it.each([
		["negotiation_failed", false],
		["no_signal", false],
		["device_busy", true],
		["composition-unsupported", false],
		["secondary-unavailable", false],
	] as const)(
		"renders the per-cause capture copy for %s",
		async (captureCause, retriable) => {
			state.failure = {
				class: "capture_source_unavailable",
				phase: "start-rpc",
				retriable,
				attemptId: `att_${captureCause}`,
				captureCause,
			};

			render(LiveView);
			await tick();

			const reason =
				startFailure.class.capture_source_unavailable[captureCause];
			const suffix = retriable
				? startFailure.retriedThenFailed
				: startFailure.notRetriable;
			expect(toastError).toHaveBeenCalledWith(`${reason} ${suffix}`, VIEW_LOGS);
			expect(reason).not.toBe(startFailed.generic);
		},
	);

	it("gives camera and cable guidance when an older failure omits its capture cause", async () => {
		state.failure = {
			class: "capture_source_unavailable",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_capture_uncategorized",
		};
		render(LiveView);
		await tick();
		expect(toastError).toHaveBeenCalledWith(
			`${en.notifications.streamStartCaptureSourceUnavailableFailed} ${startFailure.notRetriable}`,
			VIEW_LOGS,
		);
	});

	// An update in progress clears by itself: "this won't recover by retrying"
	// would tell the operator the opposite of what to do (C-m2).
	it("tells the operator to start again once an update finishes, never that retrying cannot help", async () => {
		state.failure = {
			class: "update_in_progress",
			phase: "params",
			retriable: false,
			attemptId: "att_update",
		};

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledTimes(1);
		// "Start again once it finishes" points nowhere near the logs: no action.
		expect(toastError).toHaveBeenCalledWith(
			`${startFailure.class.update_in_progress} ${startFailure.waitForUpdate}`,
			undefined,
		);
		const shown = String(toastError.mock.calls[0]?.[0] ?? "");
		expect(shown).not.toContain(startFailure.notRetriable);
		expect(shown).not.toContain(startFailure.retriedThenFailed);
	});

	it("names the signal format and the camera-side fix, never the operator's settings", () => {
		const negotiation =
			startFailure.class.capture_source_unavailable.negotiation_failed;

		expect(negotiation.toLowerCase()).toContain("format");
		expect(negotiation.toLowerCase()).toContain("camera");
		expect(negotiation.toLowerCase()).not.toContain("check your settings");
	});

	// The engine's raw diagnostic still travels to the backend logger (and so to
	// Settings → System Logs); it must never reach the operator's primary toast.
	it("keeps the raw engine diagnostic out of the typed failure toast", async () => {
		state.failure = {
			class: "start_invalid",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_d",
			message:
				"invalid params: audio-device-unavailable: ALSA capture device 'hw:CARD=rockchiphdmiin' is busy or unavailable",
		};

		render(LiveView);
		await tick();

		expect(toastError).toHaveBeenCalledWith(
			`${startFailure.class.start_invalid} ${startFailure.next.openSetup}`,
			nextStep(startFailure.action.openSetup),
		);
		const shown = String(toastError.mock.calls[0]?.[0] ?? "");
		expect(shown).not.toContain("invalid params");
		expect(shown).not.toContain("hw:CARD=");
		expect(shown).not.toContain("journalctl");
	});
});

describe("LiveView start refusals end in a next step (phone UX)", () => {
	it("a modem that could not be rolled back sends the operator to Network, not Settings", async () => {
		state.failure = {
			class: "mutation_blocked",
			phase: "params",
			retriable: false,
			attemptId: "att_modem",
		};
		render(LiveView);
		await tick();
		expect(toastError).toHaveBeenCalledWith(
			startFailure.mutationBlockedNetwork,
			nextStep(startFailure.action.openNetwork),
		);
		const [message] = toastError.mock.calls[0] ?? [];
		expect(message).not.toContain("Settings");
		expect(message).not.toContain("System Logs");
	});

	function action(call = toastError.mock.calls.at(-1)) {
		const activate = call?.[1]?.componentProps?.primary.activate;
		return activate ? { action: { onClick: activate } } : undefined;
	}

	async function startWithRefusal(
		attemptId: string,
		incrementGeneration = false,
	) {
		state.startOptimism.mockImplementation(() => {
			state.optimismState = "starting";
			if (incrementGeneration) state.generation += 1;
		});
		startStreaming.mockResolvedValueOnce({
			success: false,
			failure: {
				class: "engine_internal",
				phase: "start-rpc",
				retriable: false,
				attemptId,
			},
		});
		const view = render(LiveView);
		await fireEvent.click(view.getByTestId("start-stream"));
		await waitFor(() => expect(action()).toBeDefined());
		state.failure = failureReceipt.current;
		deliveredFailure.set(undefined);
		startStreaming.mockClear();
		state.startOptimism.mockClear();
	}

	it("Try again sends one Start through the Live bar's gate", async () => {
		delete state.config.source;
		await startWithRefusal("att_retry");
		startStreaming.mockResolvedValue({ success: true });
		action()?.action.onClick();
		await waitFor(() => expect(startStreaming).toHaveBeenCalledTimes(1));
		expect(startStreaming.mock.calls[0]?.[0]).toMatchObject({
			source: "cam-1",
		});
	});

	it("Try again sends nothing when a gate has blocked since the refusal", async () => {
		await startWithRefusal("att_blocked");
		// The only link dropped after the refusal: the Live bar would refuse Start now.
		state.netif = {};
		action()?.action.onClick();
		await tick();
		expect(state.startOptimism).not.toHaveBeenCalled();
		expect(startStreaming).not.toHaveBeenCalled();
	});

	it("Try again from a refusal that is no longer current sends nothing", async () => {
		await startWithRefusal("att_old");
		const old = action();
		state.failure = {
			class: "engine_internal",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_newer",
		};
		old?.action.onClick();
		await tick();
		expect(startStreaming).not.toHaveBeenCalled();
	});

	function engineRefusal(attemptId: string) {
		state.optimismState = "idle";
		state.failure = {
			class: "engine_internal",
			phase: "start-rpc",
			retriable: false,
			attemptId,
		};
	}

	it("Try again sends nothing while the stream outcome is unresolved", async () => {
		state.status = { stream_lifecycle: "reconciling" };
		engineRefusal("att_reconciling");
		render(LiveView);
		await tick();
		action()?.action.onClick();
		await tick();
		expect(state.startOptimism).not.toHaveBeenCalled();
		expect(startStreaming).not.toHaveBeenCalled();
	});

	it("a Try again that passes the gate but is never sent does not lead to Restart box", async () => {
		await startWithRefusal("att_unsent");
		startStreaming.mockRejectedValue(new NotSentError());
		action()?.action.onClick();
		await waitFor(() => expect(startStreaming).toHaveBeenCalledTimes(1));
		expect(state.revertOptimism).not.toHaveBeenCalled();
		expect(state.startOptimism).not.toHaveBeenCalled();
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(startStreaming).toHaveBeenCalledTimes(1);
		cleanup();
		toastError.mockReset();
		engineRefusal("att_after_unsent");
		render(LiveView);
		await tick();
		expect(toastError).toHaveBeenLastCalledWith(
			`${startFailure.class.engine_internal} ${startFailure.next.tryAgain}`,
			nextStep(startFailure.action.tryAgain),
		);
	});

	it("a refusal of a newer attempt than the retried one offers Try again, not Restart box", async () => {
		await startWithRefusal("att_g1", true);
		startStreaming.mockResolvedValue({ success: true });
		action()?.action.onClick();
		await waitFor(() => expect(startStreaming).toHaveBeenCalledTimes(1));
		// Another Start took a newer generation before this refusal arrived.
		state.generation += 1;
		cleanup();
		toastError.mockReset();
		engineRefusal("att_g3");
		render(LiveView);
		await tick();
		expect(toastError).toHaveBeenLastCalledWith(
			`${startFailure.class.engine_internal} ${startFailure.next.tryAgain}`,
			nextStep(startFailure.action.tryAgain),
		);
	});

	it("the refusal of the retried attempt itself offers Restart box", async () => {
		await startWithRefusal("att_r1", true);
		startStreaming.mockResolvedValue({ success: true });
		action()?.action.onClick();
		await waitFor(() => expect(startStreaming).toHaveBeenCalledTimes(1));
		expect(state.generation).toBe(3);
		cleanup();
		toastError.mockReset();
		engineRefusal("att_r2");
		render(LiveView);
		await tick();
		expect(toastError).toHaveBeenLastCalledWith(
			`${startFailure.class.engine_internal} ${startFailure.next.restartBox}`,
			nextStep(startFailure.action.restartBox),
		);
	});

	it("Restart box follows only an engine refusal that came back after Try again", async () => {
		await startWithRefusal("att_first");
		startStreaming.mockResolvedValue({ success: true });
		action()?.action.onClick();
		await waitFor(() => expect(startStreaming).toHaveBeenCalledTimes(1));
		cleanup();
		toastError.mockReset();
		state.failure = {
			class: "engine_unavailable",
			phase: "connect",
			retriable: true,
			attemptId: "att_second",
		};
		state.optimismState = "idle";
		render(LiveView);
		await tick();
		expect(toastError).toHaveBeenLastCalledWith(
			`${startFailure.class.engine_unavailable} ${startFailure.next.restartBox}`,
			nextStep(startFailure.action.restartBox),
		);
	});

	it("a later engine refusal without Try again still offers Try again, not Restart box", async () => {
		state.failure = {
			class: "engine_internal",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_a1",
		};
		render(LiveView);
		await tick();
		cleanup();
		toastError.mockReset();
		state.failure = {
			class: "engine_internal",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_a2",
		};
		render(LiveView);
		await tick();
		expect(toastError).toHaveBeenLastCalledWith(
			`${startFailure.class.engine_internal} ${startFailure.next.tryAgain}`,
			nextStep(startFailure.action.tryAgain),
		);
	});

	it("a refusal more than two minutes after Try again offers Try again again", async () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000_000);
		await startWithRefusal("att_t1");
		startStreaming.mockResolvedValue({ success: true });
		action()?.action.onClick();
		await waitFor(() => expect(startStreaming).toHaveBeenCalledTimes(1));
		cleanup();
		toastError.mockReset();
		now.mockReturnValue(1_000_000 + 121_000);
		state.failure = {
			class: "engine_internal",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_t2",
		};
		state.optimismState = "idle";
		render(LiveView);
		await tick();
		expect(toastError).toHaveBeenLastCalledWith(
			`${startFailure.class.engine_internal} ${startFailure.next.tryAgain}`,
			nextStep(startFailure.action.tryAgain),
		);
	});

	it("Restart box opens the guarded reboot sheet and reboots nothing by itself", async () => {
		await startWithRefusal("att_reboot_first");
		startStreaming.mockResolvedValue({ success: true });
		action()?.action.onClick();
		await waitFor(() => expect(startStreaming).toHaveBeenCalledTimes(1));
		cleanup();
		state.failure = {
			class: "engine_internal",
			phase: "start-rpc",
			retriable: false,
			attemptId: "att_reboot_second",
		};
		state.optimismState = "idle";
		const { findByTestId } = render(LiveView);
		await tick();
		action()?.action.onClick();
		expect(await findByTestId("power-dialog-open")).toBeTruthy();
		expect(reboot).not.toHaveBeenCalled();
	});

	it("Open Network goes to the Network page", async () => {
		state.failure = {
			class: "mutation_blocked",
			phase: "params",
			retriable: false,
			attemptId: "att_net",
		};
		render(LiveView);
		await tick();
		action()?.action.onClick();
		await waitFor(() => expect(navigate).toHaveBeenCalledWith("network"));
	});

	it("Open stream setup brings the setup card into view and focuses it", async () => {
		state.failure = {
			class: "start_invalid",
			phase: "params",
			retriable: false,
			attemptId: "att_setup",
		};
		const title = document.createElement("h2");
		title.id = "live-stream-setup-title";
		title.tabIndex = -1;
		title.scrollIntoView = vi.fn();
		document.body.append(title);
		try {
			render(LiveView);
			await tick();
			action()?.action.onClick();
			expect(title.scrollIntoView).toHaveBeenCalledWith({
				block: "center",
				behavior: "instant",
			});
			expect(document.activeElement).toBe(title);
		} finally {
			title.remove();
		}
	});

	it("the next-step strings exist in every locale, and the English ones never point at System Logs", async () => {
		const { ar, de, es, fr, hi, ja, ko, ptBR, zh } = await import(
			"./helpers/catalog"
		);
		for (const dict of [en, ar, de, es, fr, hi, ja, ko, ptBR, zh]) {
			const f = dict.live.startFailure;
			for (const text of [
				f.next.tryAgain,
				f.next.restartBox,
				f.next.openSetup,
				f.mutationBlockedNetwork,
				f.action.tryAgain,
				f.action.restartBox,
				f.action.openSetup,
				f.action.openNetwork,
			]) {
				expect(text.length).toBeGreaterThan(0);
			}
		}
		const f = en.live.startFailure;
		for (const text of [
			f.next.tryAgain,
			f.next.restartBox,
			f.next.openSetup,
			f.mutationBlockedNetwork,
			f.action.tryAgain,
			f.action.restartBox,
			f.action.openSetup,
			f.action.openNetwork,
		]) {
			expect(text).not.toContain("System Logs");
			expect(text).not.toContain("Settings");
		}
	});
});
