// @vitest-environment jsdom
/**
 * Device Health panel — the states that must never lie.
 *
 * Four of these assertions are about ABSENCE, and each is a different kind:
 * a signal that has never arrived (skeleton, not a zero), a collector that
 * degraded to null (the WORD "Unavailable", not a flat line and not a bare mark), a board
 * that provably lacks a sensor (a sentence, not an em-dash), and a board whose
 * encoder-load collector probed both kernel interfaces and found neither (a
 * hardware statement, NOT a roadmap promise).
 *
 * The fifth is the one this panel was redesigned around: an `active`-only core
 * must render as a BINARY mark with no figure and no percent sign, visually
 * distinct from a measured duty cycle.
 *
 * Extended (memory trace + accelerator bands + decoder cores) — ADDITIVELY. The
 * assertions above are untouched; the new describes below cover the third trace
 * channel, the GPU/DDR readouts, and the decoder list. All three obey the same
 * rule as the four absences: an ABSENT key renders NOTHING, never a zero and
 * never an empty section, because "this kernel does not report it" and "it
 * measured zero" are different statements about the board.
 */

import type { DeviceStats } from "@ceraui/rpc/schemas";
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
	memory: {
		state: "waiting",
		value: null,
		lastDeliveryAt: null,
		ageMs: null,
	} as LaneSignalStatus,
	temperatureSamples: [] as { t: number; v: number }[],
	loadSamples: [] as { t: number; v: number }[],
	memorySamples: [] as { t: number; v: number }[],
	deviceStats: undefined as DeviceStats | undefined,
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
	getMemorySamples: () => state.memorySamples,
	getMemoryStatus: () => state.memory,
	getTemperatureSamples: () => state.temperatureSamples,
	getTemperatureStatus: () => state.temperature,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getCapabilities: () => ({
		engineStarting: state.engineStarting,
		engineUnavailable: state.engineUnavailable,
	}),
	getDeviceStats: () => state.deviceStats,
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
	state.memory = {
		state: "waiting",
		value: null,
		lastDeliveryAt: null,
		ageMs: null,
	};
	state.temperatureSamples = [];
	state.loadSamples = [];
	state.memorySamples = [];
	state.deviceStats = undefined;
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

	it("a per-core unavailable inside an instrumented reading says so in WORDS", () => {
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
		// Was an em-dash carrying its meaning in a hover-only `title`. Operator
		// feedback from the deployed board: a mark you have to decode is not
		// information, least of all on a touchscreen that cannot hover.
		expect(value.textContent?.trim()).toBe(t.unavailable);
		expect(value.textContent).not.toContain("\u2014");
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

function stats(extra: Partial<DeviceStats> = {}): DeviceStats {
	return {
		disk: null,
		cpuLoad1: null,
		socTemp: null,
		ifaceRxTx: null,
		raucSlot: "A",
		...extra,
	};
}

describe("the memory trace — the third channel, and the only new one", () => {
	it("prints its own lane against a fixed 0-100 scale", () => {
		state.memorySamples = [
			{ t: state.now - 10_000, v: 41 },
			{ t: state.now - 5_000, v: 43 },
		];
		open();
		expect(byTestId("health-lane-label-memory").textContent).toContain(
			t.lane.memory,
		);
		// Fixed, not self-scaling: a board at 43 % must not draw like a board at
		// 95 % just because 43 is its own window peak.
		expect(byTestId("health-lane-scale-memory").textContent).toContain("100%");
		expect(byTestId("health-trace-field").dataset.points).toBe("2");
	});

	it("GPU and DDR stay OUT of the recorder — one new trace, not three", () => {
		state.deviceStats = stats({
			gpu: { loadPercent: 42 },
			ddr: {
				loadPercent: 23,
				curFreqHz: 528_000_000,
				maxFreqHz: 2_112_000_000,
			},
		});
		open();
		expect(maybe("health-lane-label-gpu")).toBeNull();
		expect(maybe("health-lane-label-ddr")).toBeNull();
	});

	it("an empty ring draws no lane points and never a synthesised zero", () => {
		open();
		expect(maybe("health-lane-label-memory")).not.toBeNull();
		expect(byTestId("health-trace-field").dataset.points).toBe("0");
	});
});

describe("GPU and DDR — readout row, each gated on its OWN key", () => {
	it("no row at all when neither probe answered", () => {
		state.deviceStats = stats();
		open();
		expect(maybe("device-health-loads")).toBeNull();
		expect(maybe("health-load-gpu")).toBeNull();
		expect(maybe("health-load-ddr")).toBeNull();
	});

	it("an absent device-stats snapshot is not a zero reading", () => {
		state.deviceStats = undefined;
		open();
		expect(maybe("device-health-loads")).toBeNull();
	});

	it("one probe answering does not conjure the other", () => {
		state.deviceStats = stats({ gpu: { loadPercent: 42 } });
		open();
		expect(byTestId("health-load-gpu-value").textContent).toContain("42%");
		expect(maybe("health-load-ddr")).toBeNull();
		// The kbase path structurally cannot report a frequency, so a load with
		// none beside it is an ordinary reading — never a fabricated "0 Hz".
		expect(maybe("health-load-gpu-detail")).toBeNull();
	});

	it("DDR prints Hz as Hz — devfreq's unit, never cpufreq's kHz", () => {
		state.deviceStats = stats({
			ddr: {
				loadPercent: 23,
				curFreqHz: 528_000_000,
				maxFreqHz: 2_112_000_000,
			},
		});
		open();
		expect(byTestId("health-load-ddr-value").textContent).toContain("23%");
		expect(byTestId("health-load-ddr-detail").textContent).toContain("528 MHz");
		expect(byTestId("health-load-ddr-detail").textContent).toContain(
			"2.11 GHz",
		);
	});

	it("a measured zero is kept — an idle bus is a measurement", () => {
		state.deviceStats = stats({ gpu: { loadPercent: 0 } });
		open();
		expect(byTestId("health-load-gpu-value").textContent).toContain("0%");
	});
});

describe("decoder cores — absent is not empty, and no slot is dropped", () => {
	const decoding = (
		decodeCores?: EncoderCoreReading[],
	): EncoderLoadReading => ({
		source: "mpp-service",
		cores: [{ core: "rkvenc0", kind: "percent", percent: 11.34 }],
		...(decodeCores === undefined ? {} : { decodeCores }),
		updatedAt: state.now,
		simulated: false,
	});

	it("an omitted decodeCores key renders no decoder section at all", () => {
		state.encoder = decoding();
		open();
		expect(maybe("decoder-cores")).toBeNull();
		expect(maybe("decoder-core-list")).toBeNull();
		// The encoder half is untouched by decode being unreported.
		expect(byTestId("encoder-core-value-rkvenc0").textContent).toContain(
			"11.34%",
		);
	});

	it("renders whatever length the board printed, keyed by core id", () => {
		state.encoder = decoding([
			{ core: "rkvdec0", kind: "percent", percent: 23.1 },
			{ core: "rkvdec1", kind: "percent", percent: 0 },
			{ core: "rkvdec2", kind: "percent", percent: 4.5 },
		]);
		open();
		expect(byTestId("decoder-cores").dataset.decoderCount).toBe("3");
		expect(byTestId("decoder-core-value-rkvdec0").textContent).toContain(
			"23.1",
		);
		expect(byTestId("decoder-core-value-rkvdec2").textContent).toContain("4.5");
	});

	it("a single decoder is a whole list — there is no fixed two-slot shape", () => {
		state.encoder = decoding([
			{ core: "rkvdec0", kind: "percent", percent: 7.25 },
		]);
		open();
		expect(byTestId("decoder-cores").dataset.decoderCount).toBe("1");
		expect(maybe("decoder-core-rkvdec1")).toBeNull();
	});

	it("an `unavailable` decoder KEEPS its slot — dropping it would renumber", () => {
		state.encoder = decoding([
			{ core: "rkvdec0", kind: "unavailable" },
			{ core: "rkvdec1", kind: "percent", percent: 12 },
		]);
		open();
		const rows = document.querySelectorAll(
			'[data-testid="decoder-core-list"] > li',
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.getAttribute("data-testid")).toBe("decoder-core-rkvdec0");
		expect(byTestId("decoder-core-value-rkvdec0").textContent?.trim()).toBe(
			t.unavailable,
		);
	});

	it("decode rows never move the ENCODER verdict or its precision", () => {
		state.encoder = decoding([
			{ core: "rkvdec0", kind: "percent", percent: 99 },
		]);
		open();
		expect(byTestId("encoder-cores").dataset.precision).toBe("percent");
		expect(byTestId("encoder-cores").dataset.coreCount).toBe("1");
		const list = byTestId("encoder-core-list");
		expect(list.querySelectorAll("li")).toHaveLength(1);
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
