import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "@inlang/paraglide-js";
import { build, type Plugin, resolveConfig } from "vite";
import { expect, it } from "vitest";
import {
	compactPlainMessages,
	PARAGLIDE_OUTDIR,
	PARAGLIDE_PROJECT,
} from "../../vite.i18n";

const messages = join(PARAGLIDE_OUTDIR, "messages");
const spaRuntime = join(PARAGLIDE_OUTDIR, "runtime.js");
const literal = join(messages, "live_adjustbitrate1.js");
const interpolated = join(messages, "live_golive_autoselected2.js");
const autoSelected = "live.goLive.autoSelected";
const locales = [
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
	"unknown",
];
const spaConfig = fileURLToPath(
	new URL("../../vite.config.ts", import.meta.url),
);
const sharedRuntime = "\0ceraui:plain-message";

async function withScratch<T>(
	run: (dir: string) => Promise<T> | T,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "ceraui-i18n-compact-"));
	try {
		return await run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function binding(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null)
		throw new Error("Missing ESM namespace");
	return Reflect.get(value, key);
}

async function bundle(
	dir: string,
	paths: readonly string[],
	plugins: readonly Plugin[] = [],
	runtime = spaRuntime,
) {
	mkdirSync(dir, { recursive: true });
	const entry = join(dir, "entry.mjs");
	const out = join(dir, "dist");
	writeFileSync(
		entry,
		[
			...paths.map(
				(path, index) => `import * as m${index} from ${JSON.stringify(path)};`,
			),
			`export const messages = [${paths.map((_, index) => `m${index}`).join(",")}];`,
			`export { overwriteGetLocale } from ${JSON.stringify(spaRuntime)};`,
		].join("\n"),
	);
	const emitted = new Set<string>();
	const compacted = new Set<string>();
	const observe: Plugin = {
		name: "observe_compacted_graph",
		generateBundle(_options, output) {
			for (const artifact of Object.values(output)) {
				if (artifact.type !== "chunk") continue;
				for (const id of artifact.moduleIds) {
					emitted.add(id);
					if (this.getModuleInfo(id)?.importedIds.includes(sharedRuntime))
						compacted.add(id);
				}
			}
		},
	};
	await build({
		configFile: false,
		mode: "production",
		logLevel: "error",
		plugins: [...plugins, observe],
		resolve: {
			alias:
				runtime === spaRuntime
					? []
					: [{ find: spaRuntime, replacement: runtime }],
		},
		build: {
			outDir: out,
			lib: { entry, formats: ["es"], fileName: () => "messages.mjs" },
		},
	});
	const esm: unknown = await import(
		/* @vite-ignore */ pathToFileURL(join(out, "messages.mjs")).href
	);
	const modules: unknown = binding(esm, "messages");
	const setLocale = binding(esm, "overwriteGetLocale");
	if (!Array.isArray(modules) || typeof setLocale !== "function")
		throw new Error("Incomplete ESM output");
	setLocale(() => "de");
	const messageModules: readonly unknown[] = modules;
	return {
		emitted,
		compacted,
		modules: messageModules,
		setLocale: (getLocale: () => string) => setLocale(getLocale),
	};
}

function invoke(
	module: unknown,
	key: string,
	inputs: unknown,
	options: unknown,
): unknown {
	const message = binding(module, key);
	if (typeof message !== "function")
		throw new Error(`Missing message export ${key}`);
	return message(inputs, options);
}

function render(
	module: unknown,
	key: string,
	locale?: string,
	inputs: unknown = {},
) {
	const value = invoke(
		module,
		key,
		inputs,
		locale === undefined ? undefined : { locale },
	);
	if (typeof value !== "string")
		throw new Error(`Invalid translation export ${key}`);
	return value;
}

async function productionPlugin() {
	const config = await resolveConfig(
		{ configFile: spaConfig, mode: "production" },
		"build",
		"production",
		"production",
	);
	const plugin = config.plugins.find(
		(entry) => entry.name === compactPlainMessages().name,
	);
	if (!plugin)
		throw new Error(
			"Production SPA config does not install the plain-message compactor",
		);
	return plugin;
}

it("delivers the shared production runtime and preserves every compacted catalog message", async () => {
	await withScratch(async (dir) => {
		const plugin = await productionPlugin();
		const paths = readdirSync(messages)
			.filter((file) => file.endsWith(".js"))
			.map((file) => join(messages, file));
		const before = await bundle(join(dir, "original"), paths);
		const after = await bundle(join(dir, "production"), paths, [plugin]);
		expect(after.emitted.has(sharedRuntime)).toBe(true);
		expect(after.compacted.has(literal)).toBe(true);
		expect(after.compacted.has(interpolated)).toBe(true);
		let checked = 0;
		const mismatches: string[] = [];
		const namedInputs = new Proxy(
			{},
			{
				get(_target, key) {
					return `⟨${String(key)}⟩`;
				},
			},
		);
		for (const [index, path] of paths.entries()) {
			if (!after.compacted.has(path)) continue;
			const original: unknown = before.modules[index];
			const rewritten: unknown = after.modules[index];
			if (typeof original !== "object" || original === null)
				throw new Error(`Missing compiled module ${path}`);
			if (typeof rewritten !== "object" || rewritten === null)
				throw new Error(`Missing rewritten module ${path}`);
			expect(Object.keys(rewritten)).toEqual(Object.keys(original));
			for (const key of Object.keys(original)) {
				for (const locale of [...locales, undefined]) {
					if (render(rewritten, key, locale) !== render(original, key, locale))
						mismatches.push([key, locale].join(":"));
					if (
						render(rewritten, key, locale, namedInputs) !==
						render(original, key, locale, namedInputs)
					)
						mismatches.push([key, locale, "provided input"].join(":"));
					checked += 2;
				}
			}
		}
		expect(mismatches).toEqual([]);
		console.info(
			`Production ESM parity: ${after.compacted.size} modules, ${checked} rendered comparisons`,
		);
	});
}, 90_000);

const dollars = [
	{ key: "double", en: "Show $$", de: "Zeige $$", ja: "$$ を表示" },
	{ key: "match", en: "Use $&", de: "Nutze $&", ja: "$& を使用" },
	{ key: "capture", en: "Keep $1", de: "Behalte $1", ja: "$1 を保持" },
] as const;

it("preserves real Paraglide dollar literals and locale precedence in executable ESM", async () => {
	await withScratch(async (dir) => {
		const root = join(dir, "packages/i18n");
		const project = join(root, "project.inlang");
		const catalogs = join(root, "messages");
		const output = join(root, "src/paraglide");
		const fixtureLocales = ["en", "de", "ja"] as const;
		mkdirSync(catalogs, { recursive: true });
		cpSync(PARAGLIDE_PROJECT, project, { recursive: true });
		const settings: unknown = JSON.parse(
			readFileSync(join(project, "settings.json"), "utf8"),
		);
		if (typeof settings !== "object" || settings === null)
			throw new Error("Invalid Paraglide settings");
		writeFileSync(
			join(project, "settings.json"),
			JSON.stringify({ ...settings, locales: fixtureLocales }),
		);
		for (const locale of fixtureLocales) {
			const entries = dollars.map((message) => [message.key, message[locale]]);
			writeFileSync(
				join(catalogs, `${locale}.json`),
				JSON.stringify({
					...Object.fromEntries(entries),
					single: {
						en: "English {name}",
						de: "Deutsch {name}",
						ja: "{name} の日本語",
					}[locale],
				}),
			);
		}
		const compileOptions = {
			project,
			outdir: output,
			outputStructure: "message-modules",
		} as const;
		await compile(compileOptions);
		const runtime = join(output, "runtime.js");
		const paths = dollars.map(({ key }) =>
			join(output, "messages", `${key}.js`),
		);
		const plugin = await productionPlugin();
		for (const [index, { key, en, de, ja }] of dollars.entries()) {
			const path = paths[index];
			if (path === undefined)
				throw new Error(`Missing compiled message ${key}`);
			const before = await bundle(
				join(dir, `${key}-original`),
				[path],
				[],
				runtime,
			);
			const after = await bundle(
				join(dir, `${key}-production`),
				[path],
				[plugin],
				runtime,
			);
			expect(after.compacted.has(path)).toBe(true);
			for (const [locale, expected] of [
				["en", en],
				["de", de],
				["ja", ja],
				[undefined, de],
				["unknown", en],
			] as const) {
				expect(render(before.modules[0], key, locale)).toBe(expected);
				expect(render(after.modules[0], key, locale)).toBe(expected);
			}
		}
		await compile({
			...compileOptions,
			experimentalStaticLocale: '"ja"',
		});
		const staticPaths = [...paths, join(output, "messages", "single.js")];
		const before = await bundle(
			join(dir, "static-original"),
			staticPaths,
			[],
			runtime,
		);
		const after = await bundle(
			join(dir, "static-production"),
			staticPaths,
			[plugin],
			runtime,
		);
		expect(after.compacted).toEqual(new Set(staticPaths));
		for (const [index, { key, ja }] of dollars.entries()) {
			for (const locale of [undefined, "en"]) {
				expect(render(before.modules[index], key, locale)).toBe(ja);
				expect(
					render(after.modules[index], key, locale),
					`${key}: static ja over ${locale ?? "current de"}`,
				).toBe(ja);
			}
		}
		for (const output of [before, after]) {
			const options = {
				get locale(): never {
					throw new Error("static locale must win");
				},
			};
			output.setLocale(() => {
				throw new Error("static locale must win");
			});
			expect(
				invoke(
					output.modules[dollars.length],
					"single",
					{ name: "USB" },
					options,
				),
			).toBe("USB の日本語");
		}
	});
}, 90_000);

it("preserves escaped text, fallback order, getter order and native interpolation in ESM", async () => {
	await withScratch(async (dir) => {
		const path = join(dir, "packages/i18n/src/paraglide/messages/escape.js");
		mkdirSync(join(path, ".."), { recursive: true });
		// Match the generator's spelling, including the escaped opening of a literal ${...}.
		const escaped = `"[\\\\] \\${"`"} \\${"${literal}"} $$ $& $1`;
		const original = readFileSync(interpolated, "utf8");
		const source = original
			.replace(
				`\`Auto-selected: \${i?.name}\``,
				() => `\`${escaped} \${i?.name} end\``,
			)
			.replace(
				`\`اختيار تلقائي: \${i?.name}\``,
				() => `\`قبل \${i?.name} بعد ${escaped}\``,
			)
			// A known locale without a present branch must also use the fallback.
			.replace(/^\tif \(locale === "zh"\).*[\n]/m, "");
		// Resolve all copies of the runtime to the same instance in the fixture bundle.
		const runtime = join(path, "../../runtime.js");
		cpSync(spaRuntime, runtime);
		writeFileSync(path, source);
		const before = await bundle(join(dir, "original"), [path], [], runtime);
		const after = await bundle(
			join(dir, "production"),
			[path],
			[await productionPlugin()],
			runtime,
		);
		expect(after.compacted.has(path)).toBe(true);
		const visible = `"[\\] \` \${literal} $$ $& $1`;
		for (const output of [before, after]) {
			const module = output.modules[0];
			expect(
				invoke(module, autoSelected, { name: "" }, { locale: "unknown" }),
			).toBe(`${visible}  end`);
			expect(invoke(module, autoSelected, { name: "" }, { locale: "zh" })).toBe(
				`${visible}  end`,
			);
			expect(invoke(module, autoSelected, undefined, {})).toBe(
				"Automatisch ausgewählt: undefined",
			);
			expect(invoke(module, autoSelected, null, { locale: "ar" })).toBe(
				`قبل undefined بعد ${visible}`,
			);
			for (const name of [0, false, null, undefined]) {
				expect(invoke(module, autoSelected, { name }, { locale: "ar" })).toBe(
					`قبل ${name} بعد ${visible}`,
				);
			}
			const seen: string[] = [];
			output.setLocale(() => {
				seen.push("current");
				return "ar";
			});
			const options = {
				get locale() {
					seen.push("explicit");
					return undefined;
				},
			};
			const inputs = {
				get name() {
					seen.push("input");
					return {
						[Symbol.toPrimitive](hint: string) {
							seen.push(hint);
							return "USB";
						},
					};
				},
			};
			expect(invoke(module, autoSelected, inputs, options)).toBe(
				`قبل USB بعد ${visible}`,
			);
			expect(seen).toEqual(["explicit", "current", "input", "string"]);
			seen.length = 0;
			const explicit = {
				get locale() {
					seen.push("explicit");
					return "de";
				},
			};
			expect(invoke(module, autoSelected, inputs, explicit)).toBe(
				"Automatisch ausgewählt: USB",
			);
			expect(seen).toEqual(["explicit", "input", "string"]);
			expect(() =>
				invoke(
					module,
					autoSelected,
					{ name: Symbol("native error") },
					{ locale: "de" },
				),
			).toThrow(TypeError);
			expect(() => invoke(module, autoSelected, {}, null)).toThrow(TypeError);
			const failure = new RangeError("input conversion failed");
			expect(() =>
				invoke(
					module,
					autoSelected,
					{
						name: {
							toString() {
								throw failure;
							},
						},
					},
					{},
				),
			).toThrow(failure);
		}
	});
}, 90_000);

it.each([
	["different input", `\${i?.name}\`)`, `\${i?.other}\`)`],
	[
		"fallback drifts",
		`\`Auto-selected: \${i?.name}\``,
		`\`Auto-selected: \${i?.other}\``,
	],
	["repeated input", `\${i?.name}\`)`, `\${i?.name}\${i?.name}\`)`],
	["extra expression", `\${i?.name}\`)`, `\${i?.name ?? "USB"}\`)`],
	["unsupported escape", `\${i?.name}\`)`, `\\x41\${i?.name}\`)`],
	["reserved table delimiter", `\${i?.name}\`)`, `|\${i?.name}\`)`],
	["branch predicate", 'locale === "ar"', 'locale === "ar" || locale === "de"'],
	["unknown locale", 'locale === "ar"', 'locale === "xx"'],
	["duplicate locale", 'locale === "ar"', 'locale === "de"'],
	[
		"alternate runtime import",
		"from '../runtime.js'",
		"from '../alternate.js'",
	],
	[
		"alternate runtime alias",
		"getLocale, experimentalStaticLocale",
		"getLocale as other, experimentalStaticLocale",
	],
	[
		"extra export",
		'as "live.goLive.autoSelected" }',
		'as "live.goLive.autoSelected" }\nexport const extra = 42;',
	],
])("declines unsupported interpolation: %s", async (_case, from, to) => {
	await withScratch((dir) => {
		const original = readFileSync(interpolated, "utf8");
		const changed = original.replace(from, () => to);
		if (original === changed)
			throw new Error(`Missing drift fixture anchor: ${from}`);
		const path = join(dir, "packages/i18n/src/paraglide/messages/drift.js");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, changed);
		expect(compactPlainMessages().load(path)).toBeNull();
	});
});

it("leaves a real generated plural to the normal loader", () => {
	expect(
		compactPlainMessages().load(join(messages, "live_bar_blockercount1.js")),
	).toBeNull();
});

it("does not register SPA compaction in development or federation", async () => {
	const development = await resolveConfig(
		{ configFile: spaConfig, mode: "development" },
		"serve",
	);
	const federation = await resolveConfig(
		{
			configFile: fileURLToPath(
				new URL("../../vite.federation.config.ts", import.meta.url),
			),
			mode: "production",
		},
		"build",
	);
	for (const config of [development, federation]) {
		expect(
			config.plugins.some(
				(plugin) => plugin.name === compactPlainMessages().name,
			),
		).toBe(false);
	}
});

for (const drift of [
	"unlisted locale",
	"runtime binding",
	"duplicate locale",
] as const) {
	it(`declines compiler drift: ${drift}`, async () => {
		await withScratch((dir) => {
			const source = readFileSync(literal, "utf8");
			const path = join(dir, "packages/i18n/src/paraglide/messages/drift.js");
			mkdirSync(join(path, ".."), { recursive: true });
			let changed: string;
			if (drift === "unlisted locale") {
				changed = source.replace('locale === "de"', 'locale === "xx"');
			} else if (drift === "runtime binding") {
				changed = source
					.replace(
						"getLocale, experimentalStaticLocale",
						"experimentalStaticLocale",
					)
					.replace(
						"/* eslint-disable */",
						'/* eslint-disable */\nconst getLocale = () => "ja";',
					);
			} else {
				const branch = source
					.split("\n")
					.find((line) => line.includes('locale === "de"'));
				if (!branch) throw new Error("Missing compiler branch");
				changed = source.replace(
					branch,
					() =>
						branch +
						"\n" +
						branch.replace("Bitrate anpassen", "Second German branch"),
				);
			}
			if (changed === source)
				throw new Error("Drift fixture did not change the compiler output");
			writeFileSync(path, changed);
			expect(compactPlainMessages().load(path)).toBeNull();
		});
	});
}
