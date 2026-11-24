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
	return { emitted, compacted, modules: messageModules };
}

function render(module: unknown, key: string, locale?: string) {
	const message = binding(module, key);
	if (typeof message !== "function")
		throw new Error(`Missing message export ${key}`);
	const value: unknown = message(
		{},
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
		let checked = 0;
		const mismatches: string[] = [];
		for (const [index, path] of paths.entries()) {
			if (!after.compacted.has(path)) continue;
			const original: unknown = before.modules[index];
			const rewritten: unknown = after.modules[index];
			if (typeof original !== "object" || original === null)
				throw new Error(`Missing compiled module ${path}`);
			for (const key of Object.keys(original)) {
				for (const locale of [...locales, undefined]) {
					if (render(rewritten, key, locale) !== render(original, key, locale))
						mismatches.push([key, locale].join(":"));
					checked++;
				}
			}
		}
		expect(mismatches).toEqual([]);
		console.info(
			`Literal parity: ${after.compacted.size} modules, ${checked} rendered comparisons`,
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
				JSON.stringify(Object.fromEntries(entries)),
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
		const before = await bundle(
			join(dir, "static-original"),
			paths,
			[],
			runtime,
		);
		const after = await bundle(
			join(dir, "static-production"),
			paths,
			[plugin],
			runtime,
		);
		expect(after.compacted).toEqual(new Set(paths));
		for (const [index, { key, ja }] of dollars.entries()) {
			for (const locale of [undefined, "en"]) {
				expect(render(before.modules[index], key, locale)).toBe(ja);
				expect(
					render(after.modules[index], key, locale),
					`${key}: static ja over ${locale ?? "current de"}`,
				).toBe(ja);
			}
		}
	});
}, 90_000);

it("leaves parameterized messages to the normal loader", () => {
	expect(
		compactPlainMessages().load(join(messages, "live_golive_autoselected2.js")),
	).toBeNull();
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
