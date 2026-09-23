// @vitest-environment jsdom
/**
 * EncoderDialog — "When a backup camera is slower" (capture failover, todo 21).
 *
 * The selector is FEATURE-GATED on the engine's own `failover-rate-policy`
 * token: an engine that never advertised it silently ignores the field, so
 * offering the choice there would let an operator save a policy nothing
 * applies. Absent capabilities, an absent `features` array and a features array
 * without the token all render ZERO nodes — never a disabled control, because
 * nothing is being withheld.
 */
import type { CapabilitiesMessage } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	reactiveConfig,
	reactiveSources,
} from "../../tests/fixtures/reactive-subscriptions.svelte";
import { en } from "../../tests/helpers/catalog";
import type { EncoderConfig } from "./EncoderDialog.svelte";
import EncoderDialog from "./EncoderDialog.svelte";

const capabilities = vi.hoisted(() => ({
	value: undefined as CapabilitiesMessage | undefined,
}));

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { reactiveConfig, reactiveSources } = await import(
		"../../tests/fixtures/reactive-subscriptions.svelte"
	);
	return {
		getPipelines: () => ({ hardware: "rk3588", pipelines: {} }),
		getCapabilities: () => capabilities.value,
		getDevices: () => undefined,
		getIsStreaming: () => false,
		getConfig: () => reactiveConfig.value,
		getSources: () => reactiveSources.value,
	};
});

vi.mock("$lib/components/streaming/StreamingUtils", () => ({
	normalizeValue: (value: number) => value,
	updateMaxBitrate: vi.fn(),
}));

vi.mock("$lib/rpc", () => ({
	rpc: {
		system: {
			mintPreviewToken: vi.fn(async () => ({ token: "tok-1", ttlMs: 30000 })),
		},
	},
}));

function caps(features?: string[]): CapabilitiesMessage {
	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "2160p",
		},
		encoder: {
			codecs: ["H264", "H265"],
			bitrate_range: { min: 500, max: 50000, unit: "kbps" },
		},
		sources: [],
		...(features ? { features } : {}),
	} as CapabilitiesMessage;
}

function encoderConfig(partial: Partial<EncoderConfig> = {}): EncoderConfig {
	return {
		resolution: "1080p",
		framerate: 30,
		bitrate: 6000,
		bitrateOverlay: false,
		...partial,
	};
}

function q(testid: string): HTMLElement | null {
	return document.body.querySelector(`[data-testid="${testid}"]`);
}

function saveButton(): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find(
		(b) => b.textContent?.trim() === "Save",
	) as HTMLButtonElement | undefined;
}

beforeAll(() => {
	if (!("ResizeObserver" in window)) {
		(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		};
	}
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
	reactiveConfig.reset();
	reactiveSources.reset();
	capabilities.value = undefined;
	vi.stubGlobal(
		"VideoDecoder",
		class {
			state = "configured";
			configure(): void {}
			decode(): void {}
			close(): void {}
		},
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

vi.setConfig({ testTimeout: 15000 });

describe("EncoderDialog — failover policy selector is feature-gated", () => {
	it("renders the selector when the engine advertises failover-rate-policy", () => {
		capabilities.value = caps(["composition", "failover-rate-policy"]);
		render(EncoderDialog, { props: { open: true, config: encoderConfig() } });
		flushSync();

		const selector = q("encoder-failover-policy");
		expect(selector).not.toBeNull();
		expect(selector?.textContent).toContain(
			en.live.encoder.failoverPolicy.title,
		);
		expect(q("failover-policy-retime")).not.toBeNull();
		expect(q("failover-policy-adapt")).not.toBeNull();
	});

	it("renders ZERO nodes without the token, with no features array, and with no capabilities", () => {
		for (const value of [caps(["composition"]), caps(), undefined]) {
			capabilities.value = value;
			const { unmount } = render(EncoderDialog, {
				props: { open: true, config: encoderConfig() },
			});
			flushSync();
			expect(q("encoder-failover-policy")).toBeNull();
			expect(q("failover-policy-retime")).toBeNull();
			expect(q("failover-policy-adapt")).toBeNull();
			unmount();
			document.body.innerHTML = "";
		}
	});

	it("honours a host-supplied capabilities prop on a federated mount", () => {
		capabilities.value = undefined;
		render(EncoderDialog, {
			props: {
				open: true,
				config: encoderConfig(),
				capabilities: caps(["failover-rate-policy"]),
			},
		});
		flushSync();
		expect(q("encoder-failover-policy")).not.toBeNull();
	});
});

describe("EncoderDialog — failover policy seeding and save", () => {
	beforeEach(() => {
		capabilities.value = caps(["failover-rate-policy"]);
	});

	it("seeds from the saved config and marks the current policy active", () => {
		reactiveConfig.value = { failover_rate_policy: "adapt" } as never;
		render(EncoderDialog, { props: { open: true, config: encoderConfig() } });
		flushSync();

		expect(q("failover-policy-adapt")?.getAttribute("aria-checked")).toBe(
			"true",
		);
		expect(q("failover-policy-retime")?.getAttribute("aria-checked")).toBe(
			"false",
		);
	});

	it("defaults to retime when nothing was ever saved — the device's own default", () => {
		render(EncoderDialog, { props: { open: true, config: encoderConfig() } });
		flushSync();

		expect(q("failover-policy-retime")?.getAttribute("aria-checked")).toBe(
			"true",
		);
	});

	it("writes the chosen policy to the draft on save, with no restart choice", async () => {
		const onSave = vi.fn();
		render(EncoderDialog, {
			props: { open: true, config: encoderConfig(), onSave },
		});
		flushSync();

		const adapt = q("failover-policy-adapt");
		if (!adapt) throw new Error("adapt option not rendered");
		await fireEvent.click(adapt);
		flushSync();
		expect(adapt.getAttribute("aria-checked")).toBe("true");
		expect(q("encoder-apply-choice")).toBeNull();

		const button = saveButton();
		if (!button) throw new Error("save button not rendered");
		await fireEvent.click(button);

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0]?.[0]).toMatchObject({
			failoverRatePolicy: "adapt",
			applyNow: false,
		});
	});

	it("leaves the draft field undefined when the selector is not offered", async () => {
		capabilities.value = caps();
		const onSave = vi.fn();
		render(EncoderDialog, {
			props: { open: true, config: encoderConfig(), onSave },
		});
		flushSync();

		const button = saveButton();
		if (!button) throw new Error("save button not rendered");
		await fireEvent.click(button);

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0]?.[0].failoverRatePolicy).toBeUndefined();
	});
});
