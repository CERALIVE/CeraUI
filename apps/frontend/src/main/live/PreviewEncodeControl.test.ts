// @vitest-environment jsdom
/**
 * T15 — the capability-gated hardware-preview toggle.
 *
 * The rendering contract, in three claims:
 *
 *  1. The control is ABSENT from the DOM unless the board explicitly published
 *     `preview_hw_capability === true`. Not disabled, not greyed — absent. A
 *     greyed switch invites an operator to hunt for the thing that would enable
 *     it; on a board with no hardware preview encoder there is nothing to hunt.
 *  2. The toggle is OFF until the persisted config says otherwise, and flipping
 *     it dispatches exactly `streaming.setConfig({ previewEncode })`.
 *  3. A fallen-back session shows WHY, keyed on the tagged union's `code`, and
 *     `property-failure` prints the property name the encoder actually refused.
 *     A schema test cannot catch this layer dropping `property`; this can.
 */
import type {
	CapabilitiesMessage,
	ConfigMessage,
	PreviewEncoderRealized,
} from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

let currentCaps: CapabilitiesMessage | undefined;
let currentStatus:
	| { preview_encoder_realized?: PreviewEncoderRealized | null }
	| undefined;
let currentConfig: ConfigMessage | undefined;

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getCapabilities: () => currentCaps,
	getStatus: () => currentStatus,
	getConfig: () => currentConfig,
}));

const setConfig = vi.hoisted(() => vi.fn());
vi.mock("$lib/rpc/client", () => ({
	rpc: { streaming: { setConfig } },
}));

import PreviewEncodeControl from "./PreviewEncodeControl.svelte";

const BASE_CAPS: CapabilitiesMessage = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "3840x2160",
	},
	encoder: {
		codecs: ["H264"],
		bitrate_range: { min: 500, max: 12000, unit: "kbps" },
	},
	sources: [],
};

const CAPABLE: CapabilitiesMessage = {
	...BASE_CAPS,
	preview: { enabled: true, bound: true, preview_hw_capability: true },
};

function testid(container: HTMLElement, id: string): HTMLElement | null {
	return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

beforeEach(() => {
	currentCaps = CAPABLE;
	currentStatus = undefined;
	currentConfig = undefined;
	setConfig.mockReset();
	setConfig.mockResolvedValue({
		success: true,
		applied: { previewEncode: "hardware" },
	});
});

describe("visibility — capability is the only gate", () => {
	it("renders the control when the board publishes the capability", () => {
		const { container } = render(PreviewEncodeControl);
		expect(testid(container, "preview-encode-control")).not.toBeNull();
		expect(testid(container, "preview-encode-switch")).not.toBeNull();
	});

	it.each([
		[
			"an explicit false",
			{ enabled: true, bound: true, preview_hw_capability: false },
		],
		["an absent capability field", { enabled: true, bound: true }],
	] as const)("renders NOTHING for %s", (_label, preview) => {
		currentCaps = { ...BASE_CAPS, preview };
		const { container } = render(PreviewEncodeControl);
		expect(
			container.querySelectorAll('[data-testid="preview-encode-control"]'),
		).toHaveLength(0);
		expect(
			container.querySelectorAll('[data-testid="preview-encode-switch"]'),
		).toHaveLength(0);
	});

	it("renders NOTHING when the preview block is absent entirely", () => {
		currentCaps = BASE_CAPS;
		const { container } = render(PreviewEncodeControl);
		expect(
			container.querySelectorAll('[data-testid="preview-encode-control"]'),
		).toHaveLength(0);
	});

	it("renders NOTHING before any capability snapshot has arrived", () => {
		currentCaps = undefined;
		const { container } = render(PreviewEncodeControl);
		expect(
			container.querySelectorAll('[data-testid="preview-encode-control"]'),
		).toHaveLength(0);
	});
});

describe("the toggle — default OFF, mutating the persisted request", () => {
	it("is unchecked when the config never stated a preference", () => {
		const { container } = render(PreviewEncodeControl);
		expect(
			testid(container, "preview-encode-switch")?.getAttribute("aria-checked"),
		).toBe("false");
	});

	it("is checked when the persisted config requests hardware", () => {
		currentConfig = { previewEncode: "hardware" } as ConfigMessage;
		const { container } = render(PreviewEncodeControl);
		expect(
			testid(container, "preview-encode-switch")?.getAttribute("aria-checked"),
		).toBe("true");
	});

	it('dispatches setConfig({previewEncode:"hardware"}) when switched on', async () => {
		const { container } = render(PreviewEncodeControl);
		testid(container, "preview-encode-switch")?.click();
		await tick();
		expect(setConfig).toHaveBeenCalledWith({ previewEncode: "hardware" });
	});

	it('dispatches setConfig({previewEncode:"software"}) when switched back off', async () => {
		currentConfig = { previewEncode: "hardware" } as ConfigMessage;
		setConfig.mockResolvedValue({
			success: true,
			applied: { previewEncode: "software" },
		});
		const { container } = render(PreviewEncodeControl);
		testid(container, "preview-encode-switch")?.click();
		await tick();
		expect(setConfig).toHaveBeenCalledWith({ previewEncode: "software" });
	});

	it("states that the choice applies to the NEXT stream", () => {
		const { container } = render(PreviewEncodeControl);
		expect(
			testid(container, "preview-encode-helper")?.textContent ?? "",
		).toMatch(/next stream/i);
	});
});

describe("the active reading — realized, never requested", () => {
	it("reports no live preview encoder while nothing is realized", () => {
		currentConfig = { previewEncode: "hardware" } as ConfigMessage;
		const { container } = render(PreviewEncodeControl);
		const active = testid(container, "preview-encode-active");
		expect(active).not.toBeNull();
		expect(active?.getAttribute("data-mode")).toBe("none");
	});

	it("names the hardware element a delivered session realized", () => {
		currentStatus = {
			preview_encoder_realized: {
				selected_element: "mpph264enc",
				realized_element: "mpph264enc",
				mode: "hardware",
			},
		};
		const { container } = render(PreviewEncodeControl);
		const active = testid(container, "preview-encode-active");
		expect(active?.getAttribute("data-mode")).toBe("hardware");
		expect(active?.textContent ?? "").toContain("mpph264enc");
	});

	it("names the SOFTWARE element a fallen-back session actually built", () => {
		currentConfig = { previewEncode: "hardware" } as ConfigMessage;
		currentStatus = {
			preview_encoder_realized: {
				selected_element: "mpph264enc",
				realized_element: "x264enc",
				mode: "software",
				fallback_reason: { code: "factory-missing" },
			},
		};
		const { container } = render(PreviewEncodeControl);
		const active = testid(container, "preview-encode-active");
		expect(active?.getAttribute("data-mode")).toBe("software");
		expect(active?.textContent ?? "").toContain("x264enc");
	});
});

describe("the fallback band — honest about WHY", () => {
	beforeEach(() => {
		currentConfig = { previewEncode: "hardware" } as ConfigMessage;
	});

	it("is absent when hardware was asked for and delivered", () => {
		currentStatus = {
			preview_encoder_realized: {
				selected_element: "mpph264enc",
				realized_element: "mpph264enc",
				mode: "hardware",
			},
		};
		const { container } = render(PreviewEncodeControl);
		expect(
			container.querySelectorAll('[data-testid="preview-encode-fallback"]'),
		).toHaveLength(0);
	});

	it("renders the factory-missing code with its own message", () => {
		currentStatus = {
			preview_encoder_realized: {
				selected_element: "mpph264enc",
				realized_element: "x264enc",
				mode: "software",
				fallback_reason: { code: "factory-missing" },
			},
		};
		const { container } = render(PreviewEncodeControl);
		const band = testid(container, "preview-encode-fallback");
		expect(band?.getAttribute("data-code")).toBe("factory-missing");
		expect(
			testid(container, "preview-encode-fallback-message")?.textContent ?? "",
		).toMatch(/isn't installed/i);
		// factory-missing names no property; there must be no empty slot for one.
		expect(
			container.querySelectorAll(
				'[data-testid="preview-encode-fallback-property"]',
			),
		).toHaveLength(0);
	});

	it("renders the property-failure code AND the exact refused property", () => {
		currentStatus = {
			preview_encoder_realized: {
				selected_element: "mpph264enc",
				realized_element: "x264enc",
				mode: "software",
				fallback_reason: { code: "property-failure", property: "bps" },
			},
		};
		const { container } = render(PreviewEncodeControl);
		const band = testid(container, "preview-encode-fallback");
		expect(band?.getAttribute("data-code")).toBe("property-failure");
		expect(
			testid(container, "preview-encode-fallback-message")?.textContent ?? "",
		).toMatch(/rejected a setting/i);
		expect(
			testid(container, "preview-encode-fallback-property")?.textContent,
		).toBe("bps");
	});

	it("is gone once the stop edge retracts the realized field with an explicit null", () => {
		// `subscriptions.svelte.ts` nulls `preview_encoder_realized` on the
		// true→false streaming edge precisely so a stale fallback cannot outlive
		// the session it described. An omitted field would be PRESERVED by the
		// status merge, which is why the retraction is a null and not a delete.
		currentStatus = { preview_encoder_realized: null };
		const { container } = render(PreviewEncodeControl);
		expect(
			container.querySelectorAll('[data-testid="preview-encode-fallback"]'),
		).toHaveLength(0);
		expect(
			testid(container, "preview-encode-active")?.getAttribute("data-mode"),
		).toBe("none");
	});
});
