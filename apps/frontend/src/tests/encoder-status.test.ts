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
	it.each(DENSITIES)(
		"%s — both cores are always named separately",
		(density) => {
			mount(
				reading([percent("rkvenc0", 45.53), percent("rkvenc1", 0)]),
				density,
			);
			expect(byTestId("encoder-core-rkvenc0").dataset.coreKind).toBe("percent");
			expect(byTestId("encoder-core-rkvenc1").dataset.coreKind).toBe("percent");
			expect(byTestId("encoder-core-value-rkvenc0").textContent).toContain(
				"45.53%",
			);
			expect(byTestId("encoder-core-value-rkvenc1").textContent).toContain(
				"0.00%",
			);
		},
	);

	it.each(DENSITIES)(
		"%s — a mixed reading keeps each cell's own shape",
		(density) => {
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
		},
	);

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

/**
 * The colour pass. Two properties matter and they pull against each other: the
 * state must be readable from colour at a glance, AND it must survive an
 * operator who cannot see the colour at all. So every assertion below comes in
 * pairs — a machine-readable tone, and the word that outranks it.
 */
describe("activity tone — colour reinforces the word, never replaces it", () => {
	const HEADLINE_TONES: [string, EncoderLoadReading, string, string][] = [
		[
			"encoding",
			reading([percent("rkvenc0", 45.53), percent("rkvenc1", 0)]),
			"live",
			t.cores.headlineEncoding,
		],
		[
			"idle",
			reading([percent("rkvenc0", 0), percent("rkvenc1", 0)]),
			"quiet",
			t.cores.headlineIdle,
		],
		["unreported", reading([]), "absent", t.cores.headlineUnreported],
	];

	it.each(HEADLINE_TONES)(
		"headline %s carries a tone AND its word",
		(_label, value, tone, word) => {
			for (const density of DENSITIES) {
				mount(value, density);
				const headline = byTestId("encoder-status-headline");
				expect(headline.dataset.tone).toBe(tone);
				expect(headline.textContent).toContain(word);
				document.body.innerHTML = "";
			}
		},
	);

	/**
	 * A measured 0.00 % and a `false` enable-bit are REAL observations of no
	 * work, and must not look like a core that answered nothing at all — hence
	 * `quiet` and `absent` are distinct tones rather than one "not busy" state.
	 */
	it.each([
		["a loaded percent core", "live", percent("rkvenc0", 11.34)],
		["a measured zero", "quiet", percent("rkvenc0", 0)],
		["a busy enable-bit", "live", active("rkvenc0", true)],
		["an idle enable-bit", "quiet", active("rkvenc0", false)],
		["an unreadable core", "absent", unavailable("rkvenc0")],
	])("%s is %s in both densities", (_label, tone, core) => {
		for (const density of DENSITIES) {
			// The companion core keeps the reading INSTRUMENTED — an all-unavailable
			// reading is `unreported` and draws no grid at all.
			mount(reading([core, percent("rkvenc1", 5)]), density);
			expect(byTestId("encoder-core-rkvenc0").dataset.coreTone).toBe(tone);
			document.body.innerHTML = "";
		}
	});

	/**
	 * ONE marker language. The former lucide SQUARE existed in `panel` only, so
	 * the two densities disagreed about what a per-core activity mark even looks
	 * like — and a hollow square on a surface with nothing to check read as an
	 * unticked checkbox.
	 */
	it.each(DENSITIES)(
		"%s — every core leads with the same em-scaled pip, and no checkbox glyph",
		(density) => {
			mount(
				reading([active("rkvenc0", true), active("rkvenc1", false)], {
					source: "clk-enable-count",
				}),
				density,
			);
			for (const core of ["rkvenc0", "rkvenc1"]) {
				const row = byTestId(`encoder-core-${core}`);
				const pips = row.querySelectorAll("[data-marker='pip']");
				expect(pips).toHaveLength(1);
				// LEADS with it: the marker is the row's first element, not merely
				// somewhere inside it.
				expect(row.firstElementChild).toBe(pips[0]);
				// Sized and lifted in `em`, so density changes the scale and never the
				// shape — the same declaration serves the 18px strip and the 12px row.
				expect(pips[0]?.className).toContain("size-[0.5em]");
				expect(pips[0]?.className).toContain("-translate-y-[0.1em]");
				expect(pips[0]?.getAttribute("aria-hidden")).toBe("true");
				expect(row.querySelector("svg")).toBeNull();
			}
		},
	);

	/**
	 * A RAIL IS A MAGNITUDE; A LEADER IS NOT. Only a `percent` core published a
	 * denominator, so only it may draw a filled track. The other two vocabularies
	 * get a dotted leader in that slot — which carries no fill and no
	 * `inline-size`, so it states "no scale here" while still walking the eye
	 * from the core id to its word. Leaving the slot EMPTY is what this replaced:
	 * on the full-width Device Stats band it opened a ~350px void mid-row that
	 * read as a broken layout rather than as an absent scale.
	 */
	it.each(DENSITIES)("%s — only a measured core draws a rail", (density) => {
		mount(
			reading([percent("rkvenc0", 45.53), unavailable("rkvenc1")]),
			density,
		);
		const measured = byTestId("encoder-core-rkvenc0");
		expect(measured.querySelector("[data-marker='rail']")).not.toBeNull();
		expect(measured.querySelector("[data-marker='leader']")).toBeNull();

		const unreadable = byTestId("encoder-core-rkvenc1");
		expect(unreadable.querySelector("[data-marker='rail']")).toBeNull();
		const leader = unreadable.querySelector("[data-marker='leader']");
		expect(leader).not.toBeNull();
		// The leader is decoration only, and carries no fraction of anything.
		expect(leader?.getAttribute("aria-hidden")).toBe("true");
		expect(leader?.getAttribute("style")).toBeNull();
	});

	it.each(DENSITIES)(
		"%s — a clock enable-bit gets a leader, never a rail",
		(density) => {
			mount(
				reading([active("rkvenc0", true), active("rkvenc1", false)], {
					source: "clk-enable-count",
				}),
				density,
			);
			for (const core of ["rkvenc0", "rkvenc1"]) {
				const row = byTestId(`encoder-core-${core}`);
				expect(row.querySelector("[data-marker='rail']")).toBeNull();
				expect(row.querySelector("[data-marker='leader']")).not.toBeNull();
			}
		},
	);

	it("the headline pip is the SAME marker as the core pip", () => {
		mount(reading([active("rkvenc0", true)], { source: "clk-enable-count" }));
		const headlinePip = byTestId("encoder-status-headline").querySelector(
			"[aria-hidden='true']",
		);
		const corePip = byTestId("encoder-core-rkvenc0").querySelector(
			"[aria-hidden='true']",
		);
		expect(headlinePip?.className).toBe(corePip?.className);
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

/**
 * REGRESSION LOCK — decode rows are OPT-IN, and only Device Health opts in.
 *
 * `decodeCores` landed on the shared `encoder-load` broadcast, so the reading
 * that reaches the Device Stats tile and the Live telemetry strip now carries
 * decoder rows on a vendor-6.1 board whether those surfaces want them or not.
 * Neither does: the strip is a mid-broadcast glance and the tile is one grid
 * row. The proof is stronger than "no decoder testid" — each host's markup must
 * be BYTE-IDENTICAL with the key absent and with it present, so nothing (a
 * count attribute, a wrapper, a spacing class) can drift in behind the flag.
 */
describe("decoder cores never reach the two inline hosts", () => {
	const DECODE: EncoderCoreReading[] = [
		{ core: "rkvdec0", kind: "percent", percent: 23.1 },
		{ core: "rkvdec1", kind: "unavailable" },
	];

	// The exact prop sets the two other mount sites use:
	// DeviceStatsSection.svelte:243 and StreamTelemetryStrip.svelte:124.
	const HOSTS = [
		["Device Stats tile", { density: "inline", compact: true }],
		["Live telemetry strip", { density: "inline", compact: false }],
	] as const;

	function markup(
		value: EncoderLoadReading,
		props: { density: "inline"; compact: boolean },
	): string {
		document.body.innerHTML = "";
		render(EncoderStatus, { reading: value, ...props });
		return byTestId("encoder-cores").outerHTML;
	}

	it.each(HOSTS)(
		"%s renders identically with and without decode",
		(_l, props) => {
			const cores = [percent("rkvenc0", 11.34), percent("rkvenc1", 0)];
			const without = markup(reading(cores), props);
			const withDecode = markup(reading(cores, { decodeCores: DECODE }), props);
			expect(withDecode).toBe(without);
			expect(maybe("decoder-cores")).toBeNull();
			expect(maybe("decoder-core-list")).toBeNull();
			expect(maybe("decoder-core-rkvdec0")).toBeNull();
		},
	);

	it("the panel host DOES render them, so the lock is proving a choice", () => {
		document.body.innerHTML = "";
		render(EncoderStatus, {
			reading: reading([percent("rkvenc0", 11.34)], { decodeCores: DECODE }),
			density: "panel",
			showDecoders: true,
		});
		expect(byTestId("decoder-cores").dataset.decoderCount).toBe("2");
		expect(byTestId("decoder-core-value-rkvdec0").textContent).toContain(
			"23.1",
		);
		expect(byTestId("decoder-core-value-rkvdec1").textContent).toContain(
			t.unavailable,
		);
	});

	it("opting in with NO decode rows on the wire still renders no section", () => {
		document.body.innerHTML = "";
		render(EncoderStatus, {
			reading: reading([percent("rkvenc0", 11.34)]),
			density: "panel",
			showDecoders: true,
		});
		expect(maybe("decoder-cores")).toBeNull();
	});
});
