/**
 * Shared harness for the LiveView tests that mount the REAL cockpits
 * (IdleCockpit, LiveCockpit and their StreamControlButton), the REAL
 * unconfirmed-stream band and header, and the REAL optimism and async-operation
 * stores. Each test file keeps its own `vi.mock` calls (they are hoisted per
 * file) and delegates their bodies here.
 *
 * Readings are literal: the stream controls on screen as an operator reads
 * them (label + disabled flag, in DOM order), never a value computed from the
 * predicate under test.
 */
import { streamLifecycleFixture } from "./reactive-stream-lifecycle.svelte";

const CAPTURE = {
	id: "cam-1",
	pipelineId: "cam-1-pipe",
	modes: [],
	supportsAudio: false,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audioKind: "none",
	available: true,
	origin: "capture",
	kind: "hdmi",
	displayName: "HDMI Capture",
	devicePath: "/dev/cam-1",
};

/**
 * The subscription getters for a start-ready idle device. Partial on purpose:
 * the live cockpit's subtree reads further getters, which keep their real
 * (empty) store values; only the facts under test are driven.
 */
export function subscriptionsMock<T extends object>(
	original: T,
	ingestPulledStatus: (status: unknown) => void,
): T {
	return {
		...original,
		getConfig: () => ({
			source: "cam-1",
			pipeline: "cam-1-pipe",
			relay_server: "fra",
			max_br: 6000,
		}),
		getIsStreaming: () => streamLifecycleFixture.streaming,
		getSensors: () => ({}),
		getLinkTelemetry: () => null,
		getAudioLevel: () => undefined,
		getDevices: () => [],
		getActiveInput: () => undefined,
		getConnectionState: () => "connected",
		getIsConnected: () => true,
		getCapabilities: () => undefined,
		getConfigChange: () => undefined,
		getNetif: () => ({ eth0: { enabled: true, ip: "10.0.0.2" } }),
		getRelays: () => undefined,
		getManagedIngestAccounts: () => [],
		getStatus: () => ({ stream_lifecycle: streamLifecycleFixture.lifecycle }),
		getPipelines: () => ({ pipelines: {} }),
		getSources: () => ({ hardware: "rk3588", sources: [CAPTURE] }),
		ingestPulledStatus,
	};
}

/** jsdom lacks ResizeObserver (the live bitrate slider) and scrollIntoView. */
export function installJsdomShims(scrollIntoView: () => void): void {
	if (!("ResizeObserver" in window)) {
		// Inert: nothing in these tests depends on a resize ever being observed.
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {
				// no layout in jsdom
			}
			unobserve(): void {
				// no layout in jsdom
			}
			disconnect(): void {
				// no layout in jsdom
			}
		};
	}
	Element.prototype.scrollIntoView = scrollIntoView;
}

export const OPERATION_KEY = "stream-stop-unconfirmed";
export const FAILED =
	"The device didn't confirm the stop. Try stopping the stream again.";
export const NOT_CONFIRMED =
	"The stop was sent, but the device hasn't confirmed it yet. You can try again.";

const CONTROL = /^(Start Stream|Starting\.\.\.|Stop Stream|Stopping\.\.\.)$/;

export interface StreamControl {
	label: string;
	disabled: boolean;
}

/** Every stream control on screen, in DOM order, as the operator would read it. */
export function controls(container: HTMLElement): StreamControl[] {
	return [...container.querySelectorAll("button")]
		.map((b) => ({ label: b.textContent?.trim() ?? "", disabled: b.disabled }))
		.filter((c) => CONTROL.test(c.label));
}

export function button(
	container: HTMLElement,
	label: string,
): HTMLButtonElement {
	const found = [...container.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === label,
	);
	if (!found) throw new Error(`no "${label}" button on screen`);
	return found;
}

export function band(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>(
		'[data-testid="unconfirmed-stream-band"]',
	);
}

export function header(container: HTMLElement): string {
	return container.querySelector("header")?.textContent ?? "";
}

export function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}
