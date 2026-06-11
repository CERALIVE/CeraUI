// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import PreviewCanvas from "./PreviewCanvas.svelte";

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	binaryType = "blob";
	onopen: ((e: unknown) => void) | null = null;
	onmessage: ((e: unknown) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onclose: ((e: unknown) => void) | null = null;
	readyState = 0;
	sent: unknown[] = [];
	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}
	send(data: unknown): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = 3;
	}
}

afterEach(() => {
	FakeWebSocket.instances = [];
	vi.unstubAllGlobals();
});

describe("PreviewCanvas (Task 33)", () => {
	it("shows the toggle and stays off until the operator enables it", () => {
		const { container } = render(PreviewCanvas);
		expect(
			container.querySelector('[data-testid="preview-toggle"]'),
		).not.toBeNull();
		// Off by default: no media surface, no live session.
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
		expect(container.querySelector('[data-testid="preview-video"]')).toBeNull();
	});

	it("opens a WebCodecs canvas + audio meter on toggle when VideoDecoder exists", async () => {
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "configured";
				configure(): void {}
				decode(): void {}
				close(): void {}
			},
		);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { container, getByTestId } = render(PreviewCanvas);

		await fireEvent.click(getByTestId("preview-toggle"));
		await tick();

		const section = getByTestId("preview");
		expect(section.getAttribute("data-tier")).toBe("webcodecs");
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="audio-level-meter"]'),
		).not.toBeNull();

		// The session handshake is sent on open.
		const ws = FakeWebSocket.instances.at(-1);
		expect(ws).toBeDefined();
		ws?.onopen?.({});
		expect(ws?.sent).toContain(
			JSON.stringify({ action: "start", tier: "webcodecs" }),
		);
	});

	it("falls back to the unsupported message when no codec path exists", async () => {
		for (const target of [window, globalThis] as Record<string, unknown>[]) {
			delete target.VideoDecoder;
			delete target.MediaSource;
		}
		const { container, getByTestId } = render(PreviewCanvas);

		await fireEvent.click(getByTestId("preview-toggle"));
		await tick();

		expect(getByTestId("preview").getAttribute("data-tier")).toBe("none");
		expect(getByTestId("preview").getAttribute("data-status")).toBe(
			"unsupported",
		);
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
	});

	it("tears the session down on toggle-off", async () => {
		vi.stubGlobal(
			"VideoDecoder",
			class {
				state = "configured";
				configure(): void {}
				decode(): void {}
				close(): void {}
			},
		);
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { container, getByTestId } = render(PreviewCanvas);

		await fireEvent.click(getByTestId("preview-toggle"));
		await tick();
		const ws = FakeWebSocket.instances.at(-1);
		const closeSpy = vi.spyOn(ws as FakeWebSocket, "close");

		await fireEvent.click(getByTestId("preview-toggle"));
		await tick();

		expect(closeSpy).toHaveBeenCalled();
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
	});
});
