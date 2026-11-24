/**
 * EVERY EVENT CODE HAS COPY, IN ALL TEN LOCALES.
 *
 * The parity gate (`packages/i18n/tests/locale-parity-gate.test.ts`) only proves
 * the ten catalogs agree with each other: a title missing from all ten is
 * perfectly in parity. `EVENT_REGISTRY` grows independently of the Events tab,
 * so the required keys are derived from it here, never re-typed: a new code or a
 * new enum value without copy fails this gate before a raw code can reach a row.
 */

import { readFileSync } from "node:fs";
import { EVENT_REGISTRY } from "@ceraui/rpc/events";
import { EVENT_FAMILIES } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

const LOCALES = [
	"en",
	"ar",
	"de",
	"es",
	"fr",
	"hi",
	"ja",
	"ko",
	"pt-BR",
	"zh",
] as const;

type Catalog = Record<string, unknown>;

const CATALOGS: Record<string, Catalog> = Object.fromEntries(
	LOCALES.map((locale) => [
		locale,
		JSON.parse(
			readFileSync(
				new URL(
					`../../../../packages/i18n/messages/${locale}.json`,
					import.meta.url,
				),
				"utf8",
			),
		) as Catalog,
	]),
);

const NAMESPACES = ["systemLogs", "timeline"] as const;

function keysOf(catalog: Catalog, namespace: string): string[] {
	return Object.keys(catalog)
		.filter((key) => key.startsWith(`${namespace}.`))
		.sort();
}

const CODES = Object.keys(EVENT_REGISTRY) as (keyof typeof EVENT_REGISTRY)[];

/** The params whose enum value picks one whole detail sentence per value. */
const ENUM_VARIANT_PARAMS: Partial<
	Record<keyof typeof EVENT_REGISTRY, string>
> = {
	stream_stopped: "cause",
	stream_start_failed: "class",
	stream_reconfigured: "outcome",
	stream_restore_failed: "reason",
	link_down: "reason",
	link_degraded: "reason",
	update_failed: "stage",
	shutdown_requested: "action",
};

/** Variants chosen by a boolean or by whether data was recorded. */
const FIXED_VARIANTS: Partial<
	Record<keyof typeof EVENT_REGISTRY, readonly string[]>
> = {
	engine_lost: ["streaming", "idle"],
	modem_connected: ["roaming", "notRoaming"],
	device_started: ["known", "unknown"],
};

interface ZodLike {
	shape?: Record<string, ZodLike>;
	options?: readonly unknown[];
	unwrap?: () => ZodLike;
}

function enumValues(
	code: keyof typeof EVENT_REGISTRY,
	param: string,
): string[] {
	let schema = (EVENT_REGISTRY[code].params as unknown as ZodLike).shape?.[
		param
	];
	while (schema && schema.options === undefined && schema.unwrap) {
		schema = schema.unwrap();
	}
	const options = schema?.options;
	if (!options) throw new Error(`${code}.${param} is not an enum`);
	return options.map(String);
}

function variantKeys(): string[] {
	const keys: string[] = [];
	for (const [code, param] of Object.entries(ENUM_VARIANT_PARAMS)) {
		for (const value of enumValues(code as keyof typeof EVENT_REGISTRY, param))
			keys.push(
				code === "stream_start_failed" && value === "attempt_capacity"
					? "notifications.streamStartAttemptCapacity"
					: `timeline.${code}.detail.${value}`,
			);
	}
	for (const [code, variants] of Object.entries(FIXED_VARIANTS)) {
		for (const value of variants) keys.push(`timeline.${code}.detail.${value}`);
	}
	for (const cause of enumValues("stream_start_failed", "captureCause"))
		keys.push(`timeline.stream_start_failed.capture.${cause}`);
	return keys;
}

const REQUIRED_KEYS: readonly string[] = [
	...CODES.map((code) => `timeline.${code}.title`),
	...EVENT_FAMILIES.map((family) => `timeline.family.${family}`),
	"timeline.unknown.title",
	"timeline.unknown.detail",
	...variantKeys(),
];

function missingKeys(catalog: Catalog, keys: readonly string[]): string[] {
	return keys.filter(
		(key) => typeof catalog[key] !== "string" || catalog[key] === "",
	);
}

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

function placeholders(value: string): string[] {
	return [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? "").sort();
}

// LRM, RLM, ALM and the embedding/override/isolate controls: direction belongs to
// the markup (`dir`, `<bdi>`), never to the copy.
const BIDI_CONTROL_RE = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/;

describe("the required list is derived from the registry", () => {
	it("asks for a title per code, a label per family and the unknown record", () => {
		expect(CODES.length).toBeGreaterThan(0);
		expect(REQUIRED_KEYS).toContain("timeline.stream_stopped.detail.operator");
		expect(REQUIRED_KEYS).toContain("timeline.update_failed.detail.os-staging");
		expect(new Set(REQUIRED_KEYS).size).toBe(REQUIRED_KEYS.length);
	});

	it("reports a removed title, so the gate can fail", () => {
		const damaged = { ...CATALOGS.en };
		delete damaged["timeline.stream_started.title"];
		expect(missingKeys(damaged, REQUIRED_KEYS)).toEqual([
			"timeline.stream_started.title",
		]);
	});
});

describe("every locale carries copy for every event code", () => {
	it.each(LOCALES)("%s", (locale) => {
		expect(missingKeys(CATALOGS[locale] as Catalog, REQUIRED_KEYS)).toEqual([]);
	});
});

describe("timeline copy names only what the registry defines", () => {
	it("every timeline key belongs to a registry code, a family or the unknown record", () => {
		const codes = new Set<string>(CODES);
		const orphans = keysOf(CATALOGS.en as Catalog, "timeline").filter((key) => {
			const head = key.split(".")[1] ?? "";
			return head !== "family" && head !== "unknown" && !codes.has(head);
		});
		expect(orphans).toEqual([]);
	});

	it("a code has one detail sentence or one per variant, never both", () => {
		const en = CATALOGS.en as Catalog;
		const both = CODES.filter(
			(code) =>
				`timeline.${code}.detail` in en &&
				Object.keys(en).some((key) =>
					key.startsWith(`timeline.${code}.detail.`),
				),
		);
		expect(both).toEqual([]);
	});
});

describe("the ten catalogs agree on the new namespaces", () => {
	for (const namespace of NAMESPACES) {
		const english = keysOf(CATALOGS.en as Catalog, namespace);

		it(`en carries ${namespace}.* copy`, () => {
			expect(english.length).toBeGreaterThan(0);
		});

		it.each(LOCALES)(`%s has the same ${namespace}.* keys as en`, (locale) => {
			expect(keysOf(CATALOGS[locale] as Catalog, namespace)).toEqual(english);
		});

		it.each(LOCALES)(
			`%s: every ${namespace}.* value is a plain sentence with en's placeholders`,
			(locale) => {
				const catalog = CATALOGS[locale] as Catalog;
				const wrong = english.filter((key) => {
					const value = catalog[key];
					const source = (CATALOGS.en as Catalog)[key];
					return (
						typeof value !== "string" ||
						value.trim() === "" ||
						typeof source !== "string" ||
						JSON.stringify(placeholders(value)) !==
							JSON.stringify(placeholders(source))
					);
				});
				expect(wrong).toEqual([]);
			},
		);

		it.each(LOCALES)(
			`%s: no ${namespace}.* value carries a hard-coded direction mark`,
			(locale) => {
				const catalog = CATALOGS[locale] as Catalog;
				expect(
					english.filter((key) => BIDI_CONTROL_RE.test(String(catalog[key]))),
				).toEqual([]);
			},
		);
	}
});

describe("house rules for the new copy", () => {
	const allNew = NAMESPACES.flatMap((namespace) =>
		keysOf(CATALOGS.en as Catalog, namespace),
	);

	it('never calls following "Go live"', () => {
		expect(
			allNew.filter((key) =>
				/go live/i.test(String((CATALOGS.en as Catalog)[key])),
			),
		).toEqual([]);
	});

	it("es speaks to the operator as tú (neutral Latin-American Spanish)", () => {
		const es = CATALOGS.es as Catalog;
		expect(
			allNew.filter((key) =>
				/\b(usted|ustedes|vosotros|vosotras|vuestr[oa]s?|podéis)\b/i.test(
					String(es[key]),
				),
			),
		).toEqual([]);
	});

	it.each(["es", "de", "fr"])(
		"%s translates every event title rather than copying en",
		(locale) => {
			const catalog = CATALOGS[locale] as Catalog;
			const copied = CODES.map((code) => `timeline.${code}.title`).filter(
				(key) => catalog[key] === (CATALOGS.en as Catalog)[key],
			);
			expect(copied).toEqual([]);
		},
	);
});
