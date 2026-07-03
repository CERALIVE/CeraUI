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

// Single-use token minted over the authenticated RPC socket before every dial.
const mintMock = vi.hoisted(() =>
	vi.fn(async () => ({ token: "tok-1", ttlMs: 30000 })),
);
vi.mock("$lib/rpc", () => ({
	rpc: { system: { mintPreviewToken: mintMock } },
}));

// The preview URL is now the backend origin `/preview` — never the engine port.
vi.mock("$lib/env", () => ({
	getPreviewSocketUrl: (token: string) =>
		`ws://localhost/preview?token=${token}`,
}));

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	binaryType = "blob";
	onopen: ((e: unknown) => void) | null = null;
	onmessage: ((e: unknown) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onclose: ((e: { code?: number }) => void) | null = null;
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

// Flush the async mint→dial chain (a couple microtask turns) plus Svelte ticks.
async function flush(): Promise<void> {
	await tick();
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await tick();
}

async function turnOn(getByTestId: (id: string) => HTMLElement): Promise<void> {
	await fireEvent.click(getByTestId("preview-toggle"));
	await flush();
}

afterEach(() => {
	FakeWebSocket.instances = [];
	capsMock.value = undefined;
	mintMock.mockClear();
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

	it("mints a token then opens a WebCodecs canvas dialing the backend /preview", async () => {
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

		await turnOn(getByTestId);

		const section = getByTestId("preview");
		expect(section.getAttribute("data-tier")).toBe("webcodecs");
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[data-testid="audio-level-meter"]'),
		).not.toBeNull();

		// A token was minted and the dial URL is the backend origin + token.
		expect(mintMock).toHaveBeenCalledTimes(1);
		const ws = FakeWebSocket.instances.at(-1);
		expect(ws).toBeDefined();
		expect(ws?.url).toBe("ws://localhost/preview?token=tok-1");

		// The session handshake is sent on open.
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
		// No token is minted when the browser cannot decode anything.
		expect(mintMock).not.toHaveBeenCalled();
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

		await turnOn(getByTestId);
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
		await turnOn(getByTestId);

		const band = getByTestId("preview-unavailable");
		expect(band.getAttribute("data-reason")).toBe("engineOffline");
		expect(band.getAttribute("role")).toBe("status");
		// No token minted, no socket dial — the band replaces the media surface.
		expect(mintMock).not.toHaveBeenCalled();
		expect(FakeWebSocket.instances).toHaveLength(0);
		expect(
			container.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
	});

	it("names the engine-starting condition in its own band", async () => {
		capsMock.value = { engineStarting: true };
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"engineStarting",
		);
		expect(FakeWebSocket.instances).toHaveLength(0);
	});

	it("renders the preview-unavailable band when the engine reports preview unbound", async () => {
		capsMock.value = { preview: { enabled: true, bound: false } };
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"previewUnavailable",
		);
		expect(FakeWebSocket.instances).toHaveLength(0);
	});

	it("maps close code 4502 to the engine-offline band", async () => {
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

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		FakeWebSocket.instances.at(-1)?.onclose?.({ code: 4502 });
		await tick();

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"engineOffline",
		);
	});

	it("maps close code 4503 to the preview-unavailable band", async () => {
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

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);

		FakeWebSocket.instances.at(-1)?.onclose?.({ code: 4503 });
		await tick();

		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"previewUnavailable",
		);
	});

	it("re-mints once on 4401, then surfaces the offline band on a second 4401", async () => {
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

		const { getByTestId } = render(PreviewCanvas);
		await turnOn(getByTestId);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(mintMock).toHaveBeenCalledTimes(1);

		// First 4401 → one silent re-mint + re-dial (no band yet).
		FakeWebSocket.instances.at(-1)?.onclose?.({ code: 4401 });
		await flush();
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(mintMock).toHaveBeenCalledTimes(2);

		// Second 4401 → surface the offline band, no further re-mint.
		FakeWebSocket.instances.at(-1)?.onclose?.({ code: 4401 });
		await tick();
		expect(getByTestId("preview-unavailable").getAttribute("data-reason")).toBe(
			"engineOffline",
		);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	it("reconnects while mounted when the socket drops (timer fires)", async () => {
		vi.useFakeTimers();
		try {
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

			const { getByTestId } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await tick();
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();
			expect(FakeWebSocket.instances).toHaveLength(1);

			// A dropped socket with no code while the toggle is on → bounded reconnect.
			FakeWebSocket.instances.at(-1)?.onclose?.({});
			await tick();

			// Advancing past the capped+jittered backoff (<=650ms for attempt 0)
			// fires the timer and dials a fresh socket while still mounted.
			vi.advanceTimersByTime(2000);
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves a scheduled reconnect timer inert after unmount", async () => {
		vi.useFakeTimers();
		try {
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

			const { getByTestId, unmount } = render(PreviewCanvas);
			await fireEvent.click(getByTestId("preview-toggle"));
			await tick();
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			// Drop the socket to schedule a reconnect timer, then unmount.
			FakeWebSocket.instances.at(-1)?.onclose?.({});
			await tick();
			const beforeUnmount = FakeWebSocket.instances.length;

			unmount();

			// The unmounted timer must be inert: no new socket construction,
			// no state mutation after teardown.
			vi.advanceTimersByTime(2000);
			for (let i = 0; i < 6; i++) await Promise.resolve();
			await tick();

			expect(FakeWebSocket.instances.length).toBe(beforeUnmount);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("derivePreviewAvailability", () => {
	it("treats an absent snapshot and an absent preview field as available", () => {
		expect(derivePreviewAvailability(undefined)).toBe("available");
		expect(derivePreviewAvailability({} as never)).toBe("available");
	});

	it("maps engine flags to their own conditions (starting wins over offline)", () => {
		expect(derivePreviewAvailability({ engineStarting: true } as never)).toBe(
			"engineStarting",
		);
		expect(
			derivePreviewAvailability({ engineUnavailable: true } as never),
		).toBe("engineOffline");
		expect(
			derivePreviewAvailability({
				engineStarting: true,
				engineUnavailable: true,
			} as never),
		).toBe("engineStarting");
	});

	it("flags preview unavailable when the engine reports it unbound or disabled", () => {
		expect(
			derivePreviewAvailability({
				preview: { enabled: true, bound: false },
			} as never),
		).toBe("previewUnavailable");
		expect(
			derivePreviewAvailability({
				preview: { enabled: false, bound: true },
			} as never),
		).toBe("previewUnavailable");
		expect(
			derivePreviewAvailability({
				preview: { enabled: true, bound: true },
			} as never),
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
