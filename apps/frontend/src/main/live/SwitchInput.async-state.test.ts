// @vitest-environment jsdom
/**
 * Live input switch — native-feel async state (Todo 14, S7).
 *
 * LiveView.handleSwitchInput now routes the `switchInput` RPC through the keyed
 * async-operation machine (`osCommand`, key 'switch-input') for the re-entry guard
 * + in-flight `pending` phase, while keeping the picker's nuanced switched/
 * source-lost/failed toasts. LiveView is too large to mount in isolation, so this
 * drives the same handler through `SwitchInputHarness` (real `osCommand` + real
 * `InputPicker`) and asserts in-flight, success, and failure-releases-re-entry.
 */
import type { CaptureDevice } from "@ceraui/rpc/schemas";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";
import SwitchInputHarness from "../../tests/fixtures/SwitchInputHarness.svelte";

const switchInput = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const toastWarning = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { switchInput } },
}));

vi.mock("svelte-sonner", () => ({
	toast: { success: toastSuccess, error: toastError, warning: toastWarning },
}));

const DEVICES: CaptureDevice[] = [
	{
		input_id: "video0",
		device_path: "/dev/video0",
		display_name: "HDMI In",
		media_class: "video",
		kind: "hdmi",
	},
	{
		input_id: "video63",
		device_path: "/dev/video63",
		display_name: "QA-Cam",
		media_class: "video",
		kind: "usb",
	},
];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

beforeEach(() => {
	switchInput.mockReset();
	toastSuccess.mockClear();
	toastError.mockClear();
	toastWarning.mockClear();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("LiveView switchInput — async state", () => {
	it("shows in-flight (button disabled), blocks re-entry, then confirms on success", async () => {
		const d = deferred<{ success: boolean; gap_ms?: number }>();
		switchInput.mockReturnValueOnce(d.promise);

		const { container } = render(SwitchInputHarness, {
			props: { devices: DEVICES, activeInput: "video0" },
		});

		const btn = () =>
			container.querySelector<HTMLButtonElement>(
				'[data-switch-input="video63"]',
			);
		expect(btn()?.disabled).toBe(false);

		await fireEvent.click(btn() as HTMLButtonElement); // dispatch 1 → in flight
		await Promise.resolve();
		expect(switchInput).toHaveBeenCalledOnce();
		// In-flight: the per-device Switch button is disabled (isSwitching).
		await waitFor(() => expect(btn()?.disabled).toBe(true));

		// Re-entrant click while pending must not dispatch a second switch.
		await fireEvent.click(btn() as HTMLButtonElement);
		await Promise.resolve();
		expect(switchInput).toHaveBeenCalledOnce();

		d.resolve({ success: true, gap_ms: 12 });
		await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
		await waitFor(() => expect(btn()?.disabled).toBe(false));
	});

	it("surfaces a source-lost failure and releases re-entry", async () => {
		switchInput.mockResolvedValue({ success: false, error: "SOURCE_LOST" });

		const { container } = render(SwitchInputHarness, {
			props: { devices: DEVICES, activeInput: "video0" },
		});

		const btn = () =>
			container.querySelector<HTMLButtonElement>(
				'[data-switch-input="video63"]',
			);

		await fireEvent.click(btn() as HTMLButtonElement);
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(toastSuccess).not.toHaveBeenCalled();

		// Re-entry released after the failure → a retry dispatches again.
		await waitFor(() => expect(btn()?.disabled).toBe(false));
		await fireEvent.click(btn() as HTMLButtonElement);
		await waitFor(() => expect(switchInput).toHaveBeenCalledTimes(2));
	});
});

const AUDIO_DEVICES: CaptureDevice[] = [
	...DEVICES,
	{
		input_id: "audio:usbaudio",
		device_path: "alsa:usbaudio",
		display_name: "USB audio",
		media_class: "audio",
		kind: "audio",
	},
];

describe("LiveView switchInput — audio capability guard", () => {
	it("warns via toast (never console.warn) and skips dispatch when the capability is off", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { getByTestId } = render(SwitchInputHarness, {
			props: {
				devices: AUDIO_DEVICES,
				activeInput: "video0",
				audioLiveSwitchEnabled: false,
			},
		});

		await fireEvent.click(getByTestId("force-audio-switch"));
		await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1));
		expect(switchInput).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("dispatches the audio switch once the capability is on", async () => {
		switchInput.mockResolvedValue({ success: true, gap_ms: 8 });
		const { getByTestId } = render(SwitchInputHarness, {
			props: {
				devices: AUDIO_DEVICES,
				activeInput: "video0",
				audioLiveSwitchEnabled: true,
			},
		});

		await fireEvent.click(getByTestId("force-audio-switch"));
		await waitFor(() => expect(switchInput).toHaveBeenCalledOnce());
		expect(toastWarning).not.toHaveBeenCalled();
	});
});
