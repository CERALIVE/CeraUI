// @vitest-environment jsdom
/**
 * Device Health panel — the states that must never lie.
 *
 * Four of these assertions are about ABSENCE, and each is a different kind:
 * a signal that has never arrived (skeleton, not a zero), a collector that
 * degraded to null (an em-dash labelled Unavailable, not a flat line), a board
 * that provably lacks a sensor (a sentence, not an em-dash), and a board whose
 * encoder-load collector probed both kernel interfaces and found neither (a
 * hardware statement, NOT a roadmap promise).
 *
 * The fifth is the one this panel was redesigned around: an `active`-only core
 * must render as a BINARY mark with no figure and no percent sign, visually
 * distinct from a measured duty cycle.
 */

import { render } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LaneSignalStatus } from "$lib/components/custom/health-trace-view";
import type {
	EncoderCoreReading,
	EncoderLoadReading,
} from "$lib/streaming/encoder-load";

import en from "../../../../../packages/i18n/src/en/index";

const state = {
	temperature: {
		state: "waiting",
		value: null,
		lastDeliveryAt: null,
		ageMs: null,
	} as LaneSignalStatus,
	load: {
		state: "waiting",
		value: null,
		lastDeliveryAt: null,
		ageMs: null,
	} as LaneSignalStatus,
	temperatureSamples: [] as { t: number; v: number }[],
	loadSamples: [] as { t: number; v: number }[],
	encoder: {
		source: null,
		cores: [],
		updatedAt: null,
		simulated: false,
	} as EncoderLoadReading,
	now: 1_800_000_000_000,
	hardware: "rk3588" as string | undefined,
	framesAdvancing: null as boolean | null,
	engineStarting: false,
	engineUnavailable: false,
};

vi.mock("$lib/stores/device-health-history.svelte", () => ({
	acquireHealthClock: () => () => {},
	getEncoderLoad: () => state.encoder,
	getHealthClockTick: () => state.now,
	getLoadSamples: () => state.loadSamples,
	getLoadStatus: () => state.load,
	getTemperatureSamples: () => state.temperatureSamples,
	getTemperatureStatus: () => state.temperature,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getCapabilities: () => ({
		engineStarting: state.engineStarting,
		engineUnavailable: state.engineUnavailable,
	}),
	getRevisions: () => ({ cerastream: "2026.7.5" }),
	getSources: () =>
		state.hardware === undefined
			? undefined
			: { hardware: state.hardware, sources: [] },
	getStatus: () => ({}),
}));

vi.mock("$lib/stores/hud.svelte", () => ({
	getSocTelemetry: () => ({
		temp: null,
		voltage: null,
		current: null,
		isStale: false,
	}),
}));

vi.mock("$lib/stores/stream-health.svelte", () => ({
	getStreamHealthRollup: () => ({
		state: "healthy",
		process: { alive: true },
		frames: { advancing: state.framesAdvancing, count: null },
		srt: { reconnecting: null, reconnectCount: 0 },
		bond: { linkCount: 1, activeLinks: 1 },
	}),
}));

import DeviceHealthDialog from "./DeviceHealthDialog.svelte";

const t = en.settings.deviceHealth;

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: false,
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

function reset(): void {
	state.temperature = {
		state: "waiting",
		value: null,
		lastDeliveryAt: null,
		ageMs: null,
	};
	state.load = {
		state: "waiting",
		value: null,
		lastDeliveryAt: null,
		ageMs: null,
	};
	state.temperatureSamples = [];
	state.loadSamples = [];
	state.encoder = {
		source: null,
		cores: [],
		updatedAt: null,
		simulated: false,
	};
	state.hardware = "rk3588";
	state.framesAdvancing = null;
	state.engineStarting = false;
	state.engineUnavailable = false;
}

afterEach(() => {
	reset();
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

function open(): void {
	render(DeviceHealthDialog, { open: true });
}

function byTestId(id: string): HTMLElement {
	const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	if (!el) throw new Error(`missing [data-testid="${id}"]`);
	return el;
}

function maybe(id: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("per-signal states", () => {
	it("waiting renders a skeleton, never a zero", () => {
		open();
		expect(byTestId("health-fact-temp").dataset.state).toBe("waiting");
		expect(maybe("health-fact-temp-skeleton")).not.toBeNull();
		expect(maybe("health-fact-temp-value")).toBeNull();
		expect(byTestId("health-trace-waiting").textContent).toContain(t.waiting);
	});

	it("live renders the value", () => {
		state.temperature = {
			state: "live",
			value: 62.4,
			lastDeliveryAt: state.now - 300,
			ageMs: 300,
		};
		state.load = {
			state: "live",
			value: 1.24,
			lastDeliveryAt: state.now - 900,
			ageMs: 900,
		};
		open();
		expect(byTestId("health-fact-temp-value").textContent).toContain("62.4");
		expect(byTestId("health-fact-load-value").textContent).toContain("1.24");
	});

	it("aging keeps the last known value and dims it", () => {
		state.temperature = {
			state: "aging",
			value: 62.4,
			lastDeliveryAt: state.now - 30_000,
			ageMs: 30_000,
		};
		open();
		const fact = byTestId("health-fact-temp");
		expect(fact.dataset.state).toBe("aging");
		const value = byTestId("health-fact-temp-value");
		expect(value.textContent).toContain("62.4");
		expect(value.className).toContain("opacity-50");
	});

	it("a fresh NULL delivery is Unavailable, not a flat line", () => {
		state.temperature = {
			state: "unavailable",
			value: null,
			lastDeliveryAt: state.now - 200,
			ageMs: 200,
		};
		open();
		const value = byTestId("health-fact-temp-value");
		expect(value.getAttribute("aria-label")).toBe(t.unavailable);
		expect(value.textContent?.trim()).toBe("\u2014");
	});
});

describe("encoder load — three states, three vocabularies", () => {
	it("uninstrumented states a hardware fact — NOT a roadmap promise", () => {
		// The collector ships, so a device reporting nothing has PROBED both kernel
		// interfaces and found neither. That is a fact about this board, not work
		// pending, so the calm sentence stays and the coming-soon affordance goes.
		open();
		expect(byTestId("encoder-cores").dataset.precision).toBe("none");
		expect(byTestId("encoder-cores-not-instrumented").textContent).toContain(
			t.cores.notInstrumented,
		);
		expect(
			document.querySelector('[data-debt-id="TD-encoder-load-telemetry"]'),
		).toBeNull();
		expect(document.querySelector("[data-comingsoon]")).toBeNull();
	});

	it("a measured percentage renders a figure per core", () => {
		state.encoder = {
			source: "mpp-service",
			cores: [
				{ core: "rkvenc0", kind: "percent", percent: 11.34 },
				{ core: "rkvenc1", kind: "percent", percent: 0 },
			] satisfies EncoderCoreReading[],
			updatedAt: state.now,
			simulated: false,
		};
		open();
		expect(byTestId("encoder-cores").dataset.precision).toBe("percent");
		expect(byTestId("encoder-core-value-rkvenc0").textContent).toContain(
			"11.34%",
		);
		expect(byTestId("encoder-core-value-rkvenc1").textContent).toContain(
			"0.00%",
		);
		expect(byTestId("encoder-cores-note").textContent).toContain(
			t.cores.percentNote,
		);
	});

	it("a busy/idle core NEVER renders a number or a percent sign", () => {
		state.encoder = {
			source: "clk-enable-count",
			cores: [
				{ core: "rkvenc0", kind: "active", active: true },
				{ core: "rkvenc1", kind: "active", active: false },
			] satisfies EncoderCoreReading[],
			updatedAt: state.now,
			simulated: false,
		};
		open();
		expect(byTestId("encoder-cores").dataset.precision).toBe("binary");

		const busy = byTestId("encoder-core-value-rkvenc0");
		const idle = byTestId("encoder-core-value-rkvenc1");
		expect(busy.textContent).toContain(t.cores.busy);
		expect(idle.textContent).toContain(t.cores.idle);
		for (const el of [busy, idle]) {
			expect(el.textContent).not.toMatch(/%/);
			expect(el.textContent).not.toMatch(/\d/);
		}
		expect(byTestId("encoder-cores-note").textContent).toContain(
			t.cores.binaryNote,
		);
	});

	it("the busy mark is structurally different from a percentage bar", () => {
		state.encoder = {
			source: "clk-enable-count",
			cores: [{ core: "rkvenc0", kind: "active", active: true }],
			updatedAt: state.now,
			simulated: false,
		};
		open();
		const row = byTestId("encoder-core-rkvenc0");
		expect(row.dataset.coreKind).toBe("active");
		// A percentage row is the only one that draws a proportional fill.
		expect(row.querySelector('[style*="inline-size"]')).toBeNull();
	});

	it("a per-core unavailable inside an instrumented reading is an em-dash", () => {
		state.encoder = {
			source: "mpp-service",
			cores: [
				{ core: "rkvenc0", kind: "percent", percent: 11.34 },
				{ core: "rkvenc1", kind: "unavailable" },
			] satisfies EncoderCoreReading[],
			updatedAt: state.now,
			simulated: false,
		};
		open();
		const value = byTestId("encoder-core-value-rkvenc1");
		expect(value.getAttribute("aria-label")).toBe(t.unavailable);
		expect(value.textContent?.trim()).toBe("\u2014");
	});

	it("a synthetic reading declares itself", () => {
		state.encoder = {
			source: "mpp-service",
			cores: [{ core: "rkvenc0", kind: "percent", percent: 11.34 }],
			updatedAt: state.now,
			simulated: true,
		};
		open();
		expect(byTestId("encoder-cores-simulated").textContent).toContain(
			t.cores.simulated,
		);
	});
});

describe("encoder condition", () => {
	it("`frames.advancing === null` is never rendered as stalled", () => {
		state.framesAdvancing = null;
		open();
		const text = byTestId("health-fact-encoder").textContent ?? "";
		expect(text).toContain(t.encoder.framesUnknown);
		expect(text).not.toContain(t.encoder.framesStalled);
	});

	it("only an explicit false claims a stall", () => {
		state.framesAdvancing = false;
		open();
		expect(byTestId("health-fact-encoder").textContent).toContain(
			t.encoder.framesStalled,
		);
	});

	it("an unreachable engine renders the tier language, not a fabricated idle", () => {
		state.engineUnavailable = true;
		open();
		expect(byTestId("health-fact-encoder-value").textContent).toContain(
			t.encoder.engineUnavailable,
		);
	});
});

describe("power rails", () => {
	it("asserts not-instrumented on a board that provably lacks the sensor", () => {
		state.hardware = "rk3588";
		open();
		expect(byTestId("device-health-power").dataset.powerState).toBe(
			"not-instrumented",
		);
		expect(byTestId("device-health-power-value").textContent).toContain(
			t.power.notInstrumented,
		);
	});

	it("falls back to the weaker claim when the board is unproven", () => {
		state.hardware = "generic";
		open();
		expect(byTestId("device-health-power").dataset.powerState).toBe(
			"no-reading",
		);
		expect(byTestId("device-health-power-value").textContent).toContain(
			t.power.noReading,
		);
	});

	it("an absent sources snapshot is never evidence", () => {
		state.hardware = undefined;
		open();
		expect(byTestId("device-health-power").dataset.powerState).toBe(
			"no-reading",
		);
	});
});

describe("the panel is a reading instrument", () => {
	it("contains no mutating control beyond the dialog chrome", () => {
		open();
		const panel = byTestId("device-health");
		expect(
			panel.querySelectorAll("button, input, select, textarea"),
		).toHaveLength(0);
	});

	it("keeps the now strip mounted even with nothing delivered", () => {
		open();
		expect(maybe("device-health-now")).not.toBeNull();
		expect(maybe("health-fact-encoder")).not.toBeNull();
	});
});
