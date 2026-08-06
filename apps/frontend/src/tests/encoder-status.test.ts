// @vitest-environment jsdom
/**
 * EncoderStatus — the state table, and the one rule that must hold in BOTH
 * densities.
 *
 * The headline is a derived WORD. It may never become a number, an average, or
 * a magnitude of any kind: the vendor 6.1 kernel reports a real per-core duty
 * cycle while mainline/edge 7.1 reports only the cores' clock enable-state, so
 * the two readings are incomparable and only a qualitative OR over them is
 * honest.
 *
 * The regression lock at the bottom is the important one. The `inline` density
 * drops the bar and the square for space, so the ONLY thing separating a
 * measured core from a busy/idle one there is the shape of the string — a
 * `percent` core prints a figure, an `active` core prints a word and NEVER a
 * digit. A single stray digit beside an `active` core would fabricate a
 * denominator the driver never produced.
 */
import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import EncoderStatus from "$lib/components/custom/EncoderStatus.svelte";
import * as encoderLoadModule from "$lib/streaming/encoder-load";
import {
	deriveEncoderActivity,
	type EncoderCoreReading,
	type EncoderLoadReading,
} from "$lib/streaming/encoder-load";

import en from "../../../../packages/i18n/src/en/index";

const t = en.settings.deviceHealth;

const DENSITIES = ["panel", "inline"] as const;

function reading(
	cores: EncoderCoreReading[],
	overrides: Partial<EncoderLoadReading> = {},
): EncoderLoadReading {
	return {
		source: cores.length === 0 ? null : "mpp-service",
		cores,
		updatedAt: 1_800_000_000_000,
		simulated: false,
		...overrides,
	};
}

const percent = (core: string, value: number): EncoderCoreReading => ({
	core,
	kind: "percent",
	percent: value,
});
const active = (core: string, value: boolean): EncoderCoreReading => ({
	core,
	kind: "active",
	active: value,
});
const unavailable = (core: string): EncoderCoreReading => ({
	core,
	kind: "unavailable",
});

function mount(
	value: EncoderLoadReading,
	density: (typeof DENSITIES)[number] = "panel",
	compact = false,
): void {
	render(EncoderStatus, { reading: value, density, compact });
}

function byTestId(id: string): HTMLElement {
	const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
	if (!el) throw new Error(`missing [data-testid="${id}"]`);
	return el;
}

function maybe(id: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

/**
 * An unreadable core says so in WORDS. The em-dash it used to render was a mark
 * an operator had to decode, and the word it stood for lived only in a `title`
 * that a touchscreen cannot hover to reveal.
 */
function expectUnavailableWord(core: string): void {
	const cell = byTestId(`encoder-core-value-${core}`);
	expect(cell.textContent).toContain(t.unavailable);
	expect(cell.textContent).not.toContain("\u2014");
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("deriveEncoderActivity — the qualitative OR", () => {
	it.each([
		["nothing instrumented", reading([]), "unreported"],
		[
			"every core unavailable is still unreported",
			reading([unavailable("rkvenc0"), unavailable("rkvenc1")]),
			"unreported",
		],
		[
			"all-zero percentages are idle, not unreported",
			reading([percent("rkvenc0", 0), percent("rkvenc1", 0)]),
			"idle",
		],
		[
			"one loaded percent core is encoding",
			reading([percent("rkvenc0", 45.53), percent("rkvenc1", 0)]),
			"encoding",
		],
		[
			"all-false active cores are idle",
			reading([active("rkvenc0", false), active("rkvenc1", false)]),
			"idle",
		],
		[
			"one busy active core is encoding",
			reading([active("rkvenc0", true), active("rkvenc1", false)]),
			"encoding",
		],
		[
			"mixed percent + unavailable follows the readable core",
			reading([percent("rkvenc0", 11.34), unavailable("rkvenc1")]),
			"encoding",
		],
		[
			"mixed active + unavailable follows the readable core",
			reading([active("rkvenc0", false), unavailable("rkvenc1")]),
			"idle",
		],
	])("%s", (_label, value, expected) => {
		expect(deriveEncoderActivity(value)).toBe(expected);
	});

	it("never exposes an activity-to-number helper", () => {
		// The absence IS the contract — the same absence `encoder-load.test.ts`
		// pins for `activeToPercent`. A headline magnitude would invent a scale on
		// which a duty cycle and a clock enable-bit could be added.
		const surface = Object.keys(encoderLoadModule).join(" ");
		expect(surface).not.toMatch(/toPercent|toNumber|average|aggregate/i);
	});
});

describe("headline states", () => {
	it.each(DENSITIES)("%s — not reported draws no core grid", (density) => {
		mount(reading([]), density);
		const headline = byTestId("encoder-status-headline");
		expect(headline.dataset.activity).toBe("unreported");
		expect(headline.textContent).toContain(t.cores.headlineUnreported);
		expect(maybe("encoder-core-rkvenc0")).toBeNull();
	});

	it.each(DENSITIES)("%s — idle", (density) => {
		mount(reading([percent("rkvenc0", 0), percent("rkvenc1", 0)]), density);
		const headline = byTestId("encoder-status-headline");
		expect(headline.dataset.activity).toBe("idle");
		expect(headline.textContent).toContain(t.cores.headlineIdle);
	});

	it.each(DENSITIES)("%s — encoding", (density) => {
		mount(reading([percent("rkvenc0", 45.53), percent("rkvenc1", 0)]), density);
		const headline = byTestId("encoder-status-headline");
		expect(headline.dataset.activity).toBe("encoding");
		expect(headline.textContent).toContain(t.cores.headlineEncoding);
	});

	it("panel — the not-instrumented band is a hardware statement, not a roadmap item", () => {
		mount(reading([]), "panel");
		const band = byTestId("encoder-cores-not-instrumented");
		expect(band.textContent).toContain(t.cores.notInstrumented);
		expect(document.querySelector("[data-debt-id]")).toBeNull();
		expect(document.body.textContent ?? "").not.toMatch(/coming soon/i);
	});

	it("inline — the headline stops at 'Not reported'; the sentence stays in Settings", () => {
		mount(reading([]), "inline");
		expect(maybe("encoder-cores-not-instrumented")).toBeNull();
		expect(maybe("encoder-cores-note")).toBeNull();
	});
});

describe("per-core vocabularies", () => {
	it.each(
		DENSITIES,
	)("%s — both cores are always named separately", (density) => {
		mount(reading([percent("rkvenc0", 45.53), percent("rkvenc1", 0)]), density);
		expect(byTestId("encoder-core-rkvenc0").dataset.coreKind).toBe("percent");
		expect(byTestId("encoder-core-rkvenc1").dataset.coreKind).toBe("percent");
		expect(byTestId("encoder-core-value-rkvenc0").textContent).toContain(
			"45.53%",
		);
		expect(byTestId("encoder-core-value-rkvenc1").textContent).toContain(
			"0.00%",
		);
	});

	it.each(
		DENSITIES,
	)("%s — a mixed reading keeps each cell's own shape", (density) => {
		mount(
			reading([percent("rkvenc0", 11.34), unavailable("rkvenc1")]),
			density,
		);
		expect(byTestId("encoder-core-rkvenc0").dataset.coreKind).toBe("percent");
		expect(byTestId("encoder-core-rkvenc1").dataset.coreKind).toBe(
			"unavailable",
		);
		expect(byTestId("encoder-core-value-rkvenc0").textContent).toContain(
			"11.34%",
		);
		expectUnavailableWord("rkvenc1");
	});

	it.each(DENSITIES)("%s — a mixed active + unavailable reading", (density) => {
		mount(
			reading([active("rkvenc0", true), unavailable("rkvenc1")], {
				source: "clk-enable-count",
			}),
			density,
		);
		expect(byTestId("encoder-core-value-rkvenc0").textContent).toContain(
			t.cores.busy,
		);
		expectUnavailableWord("rkvenc1");
	});

	it("panel — the precision note explains WHICH vocabulary is in use", () => {
		mount(reading([percent("rkvenc0", 1)]), "panel");
		expect(byTestId("encoder-cores-note").textContent).toContain(
			t.cores.percentNote,
		);
		document.body.innerHTML = "";
		mount(
			reading([active("rkvenc0", true)], { source: "clk-enable-count" }),
			"panel",
		);
		expect(byTestId("encoder-cores-note").textContent).toContain(
			t.cores.binaryNote,
		);
	});

	it("data-precision is machine-readable in both densities", () => {
		mount(reading([percent("rkvenc0", 1)]), "panel");
		expect(byTestId("encoder-cores").dataset.precision).toBe("percent");
		document.body.innerHTML = "";
		mount(
			reading([active("rkvenc0", true)], { source: "clk-enable-count" }),
			"inline",
		);
		expect(byTestId("encoder-cores").dataset.precision).toBe("binary");
		expect(byTestId("encoder-cores").dataset.density).toBe("inline");
	});

	it("a simulated reading stays visibly synthetic in both densities", () => {
		for (const density of DENSITIES) {
			mount(reading([percent("rkvenc0", 5)], { simulated: true }), density);
			expect(maybe("encoder-cores-simulated")?.textContent).toContain(
				t.cores.simulated,
			);
			document.body.innerHTML = "";
		}
	});
});

describe("compact inline — the Device Stats grid tile", () => {
	it("steps the headline down to the host's value scale", () => {
		mount(reading([percent("rkvenc0", 12)]), "inline", true);
		const headline = byTestId("encoder-status-headline");
		expect(headline.className).toContain("text-base");
		expect(headline.className).not.toContain("text-lg");
	});

	it("keeps the strip's larger scale when not compact", () => {
		mount(reading([percent("rkvenc0", 12)]), "inline", false);
		expect(byTestId("encoder-status-headline").className).toContain("text-lg");
	});

	it("still names both cores — a grid tile does not get to average them", () => {
		mount(
			reading([percent("rkvenc0", 45.53), percent("rkvenc1", 0)]),
			"inline",
			true,
		);
		expect(maybe("encoder-core-rkvenc0")).not.toBeNull();
		expect(maybe("encoder-core-rkvenc1")).not.toBeNull();
	});

	it("the state is never carried by the dot alone — the word is always present", () => {
		for (const value of [
			reading([]),
			reading([percent("rkvenc0", 0)]),
			reading([percent("rkvenc0", 40)]),
		]) {
			mount(value, "inline", true);
			const headline = byTestId("encoder-status-headline");
			// The dot is decoration and is hidden from assistive tech; strip it and
			// a legible word must remain.
			expect((headline.textContent ?? "").trim().length).toBeGreaterThan(0);
			expect(headline.querySelector("[aria-hidden='true']")).not.toBeNull();
			document.body.innerHTML = "";
		}
	});
});

describe("REGRESSION LOCK — an `active` core never renders a digit", () => {
	it.each(DENSITIES)("%s", (density) => {
		mount(
			reading([active("rkvenc0", true), active("rkvenc1", false)], {
				source: "clk-enable-count",
			}),
			density,
		);
		for (const core of ["rkvenc0", "rkvenc1"]) {
			const cell = byTestId(`encoder-core-value-${core}`);
			const text = cell.textContent ?? "";
			expect(text).not.toMatch(/\d/);
			expect(text).not.toContain("%");
			// No proportional bar either — an inline-size style IS a magnitude.
			expect(cell.querySelector("[style*='inline-size']")).toBeNull();
		}
		const row = byTestId("encoder-core-rkvenc0");
		expect(row.querySelector("[style*='inline-size']")).toBeNull();
	});

	it("the headline itself is never a figure", () => {
		for (const density of DENSITIES) {
			mount(
				reading([active("rkvenc0", true), percent("rkvenc1", 45.53)]),
				density,
			);
			expect(byTestId("encoder-status-headline").textContent ?? "").not.toMatch(
				/\d/,
			);
			document.body.innerHTML = "";
		}
	});
});
