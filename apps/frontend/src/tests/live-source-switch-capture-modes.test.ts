// @vitest-environment jsdom
/*
 * LiveSourceSwitch — backup-camera modes, the retimed indicator and the
 * "Match this camera" action (capture-failover-resilience todo 21).
 *
 * The component is rendered FOR REAL: the chip, the indicator and the confirm
 * dialog all live on its rows, and the point is that they agree with the
 * engine's own capture block rather than with a local guess.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import LiveSourceSwitch from "../main/live/LiveSourceSwitch.svelte";
import { en } from "./helpers/catalog";

// biome-ignore lint/suspicious/noExplicitAny: schema-shaped row literal for a render fixture
function capture(id: string, displayName: string): any {
	return {
		id,
		origin: "capture",
		kind: "uvc_h264",
		displayName,
		devicePath: id,
		pipelineId: "libuvch264",
		available: true,
		modes: [],
		audioKind: "none",
	};
}

const MAIN = capture("cam0", "Main Camera");
const BACKUP = capture("cam1", "Backup Camera");
const SOURCES = { hardware: "rk3588", sources: [MAIN, BACKUP] };

const TARGETS = [
	{
		input_id: "cam0",
		kind: "capture",
		source_width: 3840,
		source_height: 2160,
		source_framerate: 60,
	},
	{
		input_id: "cam1",
		kind: "capture",
		source_width: 1920,
		source_height: 1080,
		source_framerate: 30,
	},
];

const RETIMED_BACKUP = {
	input_id: "cam1",
	width: 1920,
	height: 1080,
	framerate: 30,
	retimed: true,
	rescaled: true,
};

// biome-ignore lint/suspicious/noExplicitAny: minimal props shim for a presentational render
function props(overrides: Record<string, any> = {}): any {
	const { capture: captureBlock, activeInput = "cam1", ...rest } = overrides;
	return {
		sources: SOURCES,
		config: { source: "cam0" },
		activeEncode: {
			codec: "h265",
			resolution: "1920x1080",
			framerate: 30,
			active_input: activeInput,
			switch_targets: TARGETS,
			capture: {
				state: "degraded",
				live_inputs: ["cam1"],
				degraded_inputs: [{ input_id: "cam0", cause: "no_signal" }],
				failover_rate_policy: "retime",
				active_source: RETIMED_BACKUP,
				...captureBlock,
			},
		},
		...rest,
	};
}

function matchButton(): HTMLButtonElement | null {
	return document.body.querySelector<HTMLButtonElement>(
		'[data-testid="match-camera-action"] button',
	);
}

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
});

describe("LiveSourceSwitch — source-mode chips", () => {
	it("renders each target's reported mode as a chip", async () => {
		const { getByTestId } = render(LiveSourceSwitch, props());
		await tick();
		expect(getByTestId("source-mode-chip-cam0").textContent?.trim()).toBe(
			"2160p60",
		);
		expect(getByTestId("source-mode-chip-cam1").textContent?.trim()).toBe(
			"1080p30",
		);
	});

	it("renders NO chip for a target that reports no mode", async () => {
		const { queryByTestId } = render(
			LiveSourceSwitch,
			props({
				activeEncode: {
					active_input: "cam0",
					switch_targets: [
						{ input_id: "cam0", kind: "capture" },
						{ input_id: "cam1", kind: "capture" },
					],
				},
			}),
		);
		await tick();
		expect(queryByTestId("source-mode-chip-cam0")).toBeNull();
		expect(queryByTestId("source-mode-chip-cam1")).toBeNull();
	});
});

describe("LiveSourceSwitch — the standby leg is never a row", () => {
	it("filters a standby target out even if the engine ever listed one", async () => {
		const { container } = render(
			LiveSourceSwitch,
			props({
				activeInput: "standby",
				activeEncode: {
					active_input: "standby",
					switch_targets: [
						...TARGETS,
						{ input_id: "standby", kind: "synthetic" },
					],
					capture: { state: "standby", live_inputs: [], degraded_inputs: [] },
				},
			}),
		);
		await tick();
		expect(
			container.querySelector('[data-source-switch-row="standby"]'),
		).toBeNull();
		expect(container.querySelectorAll("[data-source-switch-row]")).toHaveLength(
			2,
		);
	});

	it("on standby every camera row offers Switch and none is affirmed active", async () => {
		const { container } = render(
			LiveSourceSwitch,
			props({
				activeInput: "standby",
				activeEncode: {
					active_input: "standby",
					switch_targets: TARGETS,
					capture: { state: "standby", live_inputs: [], degraded_inputs: [] },
				},
			}),
		);
		await tick();
		expect(container.querySelectorAll("[data-switch-input]")).toHaveLength(2);
		expect(
			container.querySelector('[data-testid^="source-selected-"]'),
		).toBeNull();
	});
});

describe("LiveSourceSwitch — 'Repeating frames' indicator", () => {
	it("shows on the ACTIVE row when the engine reports the active source retimed", async () => {
		const { getByTestId } = render(LiveSourceSwitch, props());
		await tick();
		const indicator = getByTestId("source-retimed-indicator");
		expect(indicator.textContent).toContain(en.live.capture.repeatingFrames);
		expect(
			indicator
				.closest("[data-source-switch-row]")
				?.getAttribute("data-source-switch-row"),
		).toBe("cam1");
	});

	it("does NOT show when the active source is not retimed", async () => {
		const { queryByTestId } = render(
			LiveSourceSwitch,
			props({
				capture: { active_source: { ...RETIMED_BACKUP, retimed: false } },
			}),
		);
		await tick();
		expect(queryByTestId("source-retimed-indicator")).toBeNull();
	});

	it("does NOT show when the engine reports no capture block at all", async () => {
		const { queryByTestId } = render(
			LiveSourceSwitch,
			props({
				activeEncode: { active_input: "cam1", switch_targets: TARGETS },
			}),
		);
		await tick();
		expect(queryByTestId("source-retimed-indicator")).toBeNull();
	});
});

describe("LiveSourceSwitch — 'Match this camera' action", () => {
	it("offers the match on the active row under the retime policy, naming the mode", async () => {
		render(LiveSourceSwitch, props());
		await tick();
		const button = matchButton();
		expect(button).not.toBeNull();
		expect(button?.textContent).toContain(
			en.live.capture.matchCamera.replace("{mode}", "1080p30"),
		);
	});

	it("does NOT offer the match under the adapt policy — the engine already matched", async () => {
		render(
			LiveSourceSwitch,
			props({ capture: { failover_rate_policy: "adapt" } }),
		);
		await tick();
		expect(matchButton()).toBeNull();
	});

	it("does NOT offer the match when the active source already matches the settings", async () => {
		render(
			LiveSourceSwitch,
			props({
				capture: {
					active_source: { ...RETIMED_BACKUP, retimed: false, rescaled: false },
				},
			}),
		);
		await tick();
		expect(matchButton()).toBeNull();
		expect(
			document.body.querySelector('[data-testid="source-retimed-indicator"]'),
		).toBeNull();
	});

	it("opens a confirm dialog that states the reconnect and the saved settings, and dispatches ONLY on confirm", async () => {
		const onMatchCamera = vi.fn();
		render(LiveSourceSwitch, props({ onMatchCamera }));
		await tick();

		const trigger = matchButton();
		if (!trigger) throw new Error("match action not rendered");
		await fireEvent.click(trigger);

		const dialog = await waitFor(() => {
			const el = document.body.querySelector('[role="alertdialog"]');
			if (!el) throw new Error("confirm dialog not open");
			return el;
		});
		expect(dialog.textContent).toContain(en.live.capture.matchConfirmTitle);
		expect(dialog.textContent).toContain(
			en.live.capture.matchConfirmBody.replace("{mode}", "1080p30"),
		);
		expect(onMatchCamera).not.toHaveBeenCalled();

		const confirm = Array.from(dialog.querySelectorAll("button")).find((b) =>
			b.textContent?.includes(en.live.capture.matchConfirmAction),
		);
		if (!confirm) throw new Error("confirm button not rendered");
		await fireEvent.click(confirm);

		expect(onMatchCamera).toHaveBeenCalledTimes(1);
		expect(onMatchCamera).toHaveBeenCalledWith({
			inputId: "cam1",
			mode: "1080p30",
			resolution: "1080p",
			framerate: 30,
		});
	});

	it("dispatches nothing on cancel", async () => {
		const onMatchCamera = vi.fn();
		render(LiveSourceSwitch, props({ onMatchCamera }));
		await tick();

		const trigger = matchButton();
		if (!trigger) throw new Error("match action not rendered");
		await fireEvent.click(trigger);
		const dialog = await waitFor(() => {
			const el = document.body.querySelector('[role="alertdialog"]');
			if (!el) throw new Error("confirm dialog not open");
			return el;
		});
		const cancel = Array.from(dialog.querySelectorAll("button")).find((b) =>
			b.textContent?.includes(en.dialog.cancel),
		);
		if (!cancel) throw new Error("cancel button not rendered");
		await fireEvent.click(cancel);

		expect(onMatchCamera).not.toHaveBeenCalled();
	});
});
