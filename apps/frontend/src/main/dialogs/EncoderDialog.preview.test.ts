// @vitest-environment jsdom
/**
 * EncoderDialog — live preview mount (#72).
 *
 * The encoder dialog hosts the SAME `PreviewCanvas` used on the Live view, in a
 * constrained `compact` form so the modal doesn't double up the card chrome the
 * dialog already provides. The preview owns its own WebSocket + toggle, so the
 * dialog only has to mount it near the source/codec controls and rely on the
 * component's effect-cleanup for teardown.
 *
 * Coverage:
 *  1. The compact PreviewCanvas renders inside the open dialog.
 *  2. Toggling the preview mounts the canvas + audio meter WITHOUT closing the
 *     dialog (the toggle is local to the component, not a dialog action).
 *  3. Unmounting the dialog tears the preview socket down (no stale WebSocket
 *     leaks across dialog open/close).
 */
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import EncoderDialog from "./EncoderDialog.svelte";

// EncoderDialog reads exclusively through the subscriptions surface; an all-empty
// snapshot is the pre-capability state the real LiveView mounts it in, and every
// ValidationAdapter helper is undefined-safe for it.
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getPipelines: () => undefined,
	getCapabilities: () => undefined,
	getDevices: () => undefined,
	getIsStreaming: () => false,
	getConfig: () => undefined,
	getStatus: () => undefined,
}));

// Save-path only — never invoked by a render/toggle test. Mocking it keeps the
// SystemHelper → rpc/WebSocket chain out of the component test entirely.
vi.mock("$lib/components/streaming/StreamingUtils", () => ({
	normalizeValue: (value: number) => value,
	updateMaxBitrate: vi.fn(),
}));

// A minimal in-memory WebSocket so toggling the preview on never opens a real
// socket; mirrors the PreviewCanvas unit test's fake.
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

function previewSection(): HTMLElement | null {
	return document.body.querySelector<HTMLElement>('[data-testid="preview"]');
}

beforeAll(() => {
	// The bitrate Slider (bits-ui) installs a ResizeObserver, absent in jsdom.
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
	// AppDialog selects Dialog vs Sheet via `new MediaQuery(...)` → matchMedia,
	// absent in jsdom. Force the desktop Dialog branch (portaled to body).
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

beforeEach(() => {
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
});

afterEach(() => {
	FakeWebSocket.instances = [];
	vi.unstubAllGlobals();
});

describe("EncoderDialog — live preview (#72)", () => {
	it("mounts a compact PreviewCanvas inside the open dialog", () => {
		render(EncoderDialog, { props: { open: true } });

		const preview = previewSection();
		expect(preview, "preview must render inside the dialog").not.toBeNull();
		// Compact form: the dialog supplies the chrome, so the preview drops its
		// own card border/padding and flags it for downstream styling/QA.
		expect(preview?.getAttribute("data-compact")).toBe("true");
		// Toggle is present but the preview is OFF until the operator enables it.
		expect(
			document.body.querySelector('[data-testid="preview-toggle"]'),
		).not.toBeNull();
		expect(
			document.body.querySelector('[data-testid="preview-canvas"]'),
		).toBeNull();
	});

	it("toggles the preview on without closing the dialog", async () => {
		render(EncoderDialog, { props: { open: true } });

		const toggle = document.body.querySelector<HTMLElement>(
			'[data-testid="preview-toggle"]',
		);
		expect(toggle).not.toBeNull();
		await fireEvent.click(toggle as HTMLElement);
		await tick();

		// Media surface + audio meter mount in-place…
		expect(
			document.body.querySelector('[data-testid="preview-canvas"]'),
		).not.toBeNull();
		expect(
			document.body.querySelector('[data-testid="audio-level-meter"]'),
		).not.toBeNull();
		// …and the dialog is still open (the toggle is component-local).
		expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
		expect(previewSection()).not.toBeNull();

		// The session handshake is sent on socket open.
		const ws = FakeWebSocket.instances.at(-1);
		expect(ws).toBeDefined();
		ws?.onopen?.({});
		expect(ws?.sent).toContain(
			JSON.stringify({ action: "start", tier: "webcodecs" }),
		);
	});

	it("tears the preview socket down when the dialog unmounts", async () => {
		const view = render(EncoderDialog, { props: { open: true } });

		await fireEvent.click(
			document.body.querySelector(
				'[data-testid="preview-toggle"]',
			) as HTMLElement,
		);
		await tick();
		const ws = FakeWebSocket.instances.at(-1);
		const closeSpy = vi.spyOn(ws as FakeWebSocket, "close");

		view.unmount();
		await tick();

		expect(closeSpy).toHaveBeenCalled();
	});
});
