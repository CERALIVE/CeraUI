// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import PreviewCanvas from "./PreviewCanvas.svelte";
import {
	cappedAttemptText,
	derivePreviewAvailability,
} from "./preview-availability";

// Controllable capability snapshot: the component reads it through
// getCapabilities() to decide whether the preview is dialable.
const capsMock = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getCapabilities: () => capsMock.value,
}));

// Force the prod-like branch (IS_DEV=false) so the engine-aware unavailability
// logic is active; a dev build always dials the mock preview server instead.
vi.mock("$lib/env", () => ({
	BUILD_INFO: {
		IS_DEV: false,
		IS_PROD: true,
		IS_SSR: false,
		MODE: "test",
		NODE_ENV: "test",
	},
	getPreviewSocketUrl: () => "ws://localhost:9997",
}));

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
	capsMock.value = undefined;
	vi.unstubAllGlobals();
});

describe("PreviewCanvas", () => {
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

	it("shows the 'preview off' copy (not noSignal) while the toggle is off", () => {
		const { getByTestId } = render(PreviewCanvas);
		const off = getByTestId("preview-off");
		expect(off).not.toBeNull();
		expect(off.textContent).toMatch(/preview off/i);
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

	it("renders a calm engine-offline band and never dials when the engine is unavailable", async () => {
		capsMock.value = { engineUnavailable: true };
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

		const band = getByTestId("preview-unavailable");
		expect(band.getAttribute("data-reason")).toBe("engineOffline");
		expect(band.getAttribute("role")).toBe("status");
		// No socket dial — the band replaces the media surface entirely.
		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
	});

	it("names the engine-starting condition in its own band", async () => {
		capsMock.value = { engineStarting: true };
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await fireEvent.click(getByTestId("preview-toggle"));
		await tick();

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"engineStarting",
		);
		expect(FakeWebSocket.instances).toHaveLength(0);
	});

	it("renders the preview-unavailable band when the engine reports preview unbound", async () => {
		capsMock.value = { preview: { enabled: true, bound: false } };
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await fireEvent.click(getByTestId("preview-toggle"));
		await tick();

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"previewUnavailable",
		);
		expect(FakeWebSocket.instances).toHaveLength(0);
	});
});

describe("derivePreviewAvailability", () => {
	it("always dials in a mock-backed dev build, ignoring the snapshot", () => {
		expect(
			derivePreviewAvailability({ engineUnavailable: true } as never, true),
		).toBe("available");
		expect(
			derivePreviewAvailability(
				{ preview: { enabled: false, bound: false } } as never,
				true,
			),
		).toBe("available");
	});

	it("treats an absent snapshot and an absent preview field as available", () => {
		expect(derivePreviewAvailability(undefined, false)).toBe("available");
		expect(derivePreviewAvailability({} as never, false)).toBe("available");
	});

	it("maps engine flags to their own conditions (starting wins over offline)", () => {
		expect(
			derivePreviewAvailability({ engineStarting: true } as never, false),
		).toBe("engineStarting");
		expect(
			derivePreviewAvailability({ engineUnavailable: true } as never, false),
		).toBe("engineOffline");
		expect(
			derivePreviewAvailability(
				{ engineStarting: true, engineUnavailable: true } as never,
				false,
			),
		).toBe("engineStarting");
	});

	it("flags preview unavailable when the engine reports it unbound or disabled", () => {
		expect(
			derivePreviewAvailability(
				{ preview: { enabled: true, bound: false } } as never,
				false,
			),
		).toBe("previewUnavailable");
		expect(
			derivePreviewAvailability(
				{ preview: { enabled: false, bound: true } } as never,
				false,
			),
		).toBe("previewUnavailable");
		expect(
			derivePreviewAvailability(
				{ preview: { enabled: true, bound: true } } as never,
				false,
			),
		).toBe("available");
	});
});

describe("cappedAttemptText", () => {
	it("is empty before the first reconnect and caps at the ceiling", () => {
		expect(cappedAttemptText(0)).toBe("");
		expect(cappedAttemptText(1)).toBe("1");
		expect(cappedAttemptText(4)).toBe("4");
		expect(cappedAttemptText(5)).toBe("5+");
		expect(cappedAttemptText(99)).toBe("5+");
	});
});
