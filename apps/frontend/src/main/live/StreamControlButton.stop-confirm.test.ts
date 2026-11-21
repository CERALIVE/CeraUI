// @vitest-environment jsdom
/**
 * The Live bar's Stop asks before it ends the stream.
 *
 * On a phone the Stop button sits in the thumb zone right above the mobile
 * dock, so a pocket tap or a missed tap on the dock used to end the broadcast.
 * With `confirmStop` a tap opens "End the stream?" and only End stream reaches
 * `onStop`; Keep streaming, Escape and a second tap on the spot where Stop was
 * send nothing. Without the prop (the idle hosts) Stop stays one tap.
 */
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StreamingOptimismState } from "$lib/rpc/streaming-optimism.svelte";
import { en } from "../../tests/helpers/catalog";
import StreamControlButton from "./StreamControlButton.svelte";

function mount(props: {
	confirmStop?: boolean;
	isStreaming?: boolean;
	optimismState?: StreamingOptimismState;
	onStop?: () => void;
}) {
	const onStop = props.onStop ?? vi.fn();
	const view = render(StreamControlButton, {
		props: {
			isStreaming: props.isStreaming ?? true,
			canStart: false,
			optimismState: props.optimismState ?? "idle",
			onStart: () => {},
			onStop,
			...(props.confirmStop === undefined
				? {}
				: { confirmStop: props.confirmStop }),
		},
	});
	return { ...view, onStop };
}

function stopButton(): HTMLButtonElement {
	return screen.getByRole("button", {
		name: en.live.stopStream,
	}) as HTMLButtonElement;
}

describe("StreamControlButton — Stop asks first in the Live bar", () => {
	afterEach(cleanup);

	it("a single tap on Stop never sends the stop", async () => {
		const { onStop } = mount({ confirmStop: true });
		await fireEvent.click(stopButton());
		await waitFor(() => expect(screen.getByRole("alertdialog")).toBeTruthy());
		expect(onStop).not.toHaveBeenCalled();
	});

	it("asks 'End the stream?' and says what the box will do", async () => {
		mount({ confirmStop: true });
		await fireEvent.click(stopButton());
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog.textContent).toContain(en.live.stopConfirm.title);
		expect(dialog.textContent).toContain(en.live.stopConfirm.body);
		expect(
			screen.getByRole("button", { name: en.live.stopConfirm.keep }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: en.live.stopConfirm.end }),
		).toBeTruthy();
	});

	it("End stream sends the stop exactly once and closes the question", async () => {
		const { onStop } = mount({ confirmStop: true });
		await fireEvent.click(stopButton());
		await fireEvent.click(
			await screen.findByRole("button", { name: en.live.stopConfirm.end }),
		);
		expect(onStop).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	it("Keep streaming closes the question without stopping", async () => {
		const { onStop } = mount({ confirmStop: true });
		await fireEvent.click(stopButton());
		await fireEvent.click(
			await screen.findByRole("button", { name: en.live.stopConfirm.keep }),
		);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onStop).not.toHaveBeenCalled();
	});

	it("Escape closes the question without stopping", async () => {
		const { onStop } = mount({ confirmStop: true });
		await fireEvent.click(stopButton());
		const dialog = await screen.findByRole("alertdialog");
		await fireEvent.keyDown(dialog, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onStop).not.toHaveBeenCalled();
	});

	it("Keep streaming takes the initial focus, so Enter does not end the stream", async () => {
		mount({ confirmStop: true });
		await fireEvent.click(stopButton());
		const keep = await screen.findByRole("button", {
			name: en.live.stopConfirm.keep,
		});
		await waitFor(() => expect(document.activeElement).toBe(keep));
	});

	it("the question goes away when the stream stops some other way", async () => {
		const { onStop, rerender } = mount({ confirmStop: true });
		await fireEvent.click(stopButton());
		await screen.findByRole("alertdialog");
		await rerender({ isStreaming: false });
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(onStop).not.toHaveBeenCalled();
	});

	it("without confirmStop, Stop stays one tap", async () => {
		const { onStop } = mount({});
		await fireEvent.click(stopButton());
		expect(onStop).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("the dialog strings ship in every locale", async () => {
		const { ar, de, es, fr, hi, ja, ko, ptBR, zh } = await import(
			"../../tests/helpers/catalog"
		);
		for (const dict of [en, ar, de, es, fr, hi, ja, ko, ptBR, zh]) {
			const c = dict.live.stopConfirm;
			for (const value of [c.title, c.body, c.keep, c.end]) {
				expect(typeof value).toBe("string");
				expect(value.length).toBeGreaterThan(0);
			}
		}
	});
});
