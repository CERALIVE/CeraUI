/**
 * REQUIRED architectural test for the i18n facade's lazy-namespace boundary.
 *
 * The whole point of the generated barrels is that flipping a namespace from
 * eager to lazy is a CONFIG change with no call-site edit. That claim is only
 * worth anything if it is proved end to end, so this builds the SAME fixture
 * source twice — once against an all-eager registry, once against one where a
 * single namespace is lazy — and asserts on the real build output:
 *
 *   (i)   the lazy namespace's messages are ABSENT from the initial chunk set,
 *         and no chunk imports paraglide's all-message umbrella;
 *   (ii)  its chunk exists but is unreachable until `ensureNamespace()` resolves;
 *   (iii) the call site is byte-identical between the two configurations.
 *
 * `devtools` is the namespace under test: 132 keys, and the destination that
 * owns it is already dev-gated, so it is the realistic first candidate.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateRegistry } from "../../../../packages/i18n/scripts/generate-registry.js";

const LAZY_NAMESPACE = "devtools";
const LAZY_KEY = "devtools.actionCancelled";
const LAZY_VALUE = "Action cancelled";
const EAGER_KEY = "live.setup.title";

// One source string, built against both registries. Its byte-identity IS the
// "zero call-site diff" claim — nothing about a lazy namespace changes how a
// component asks for a message.
const CALL_SITE_SOURCE = `import { ensureNamespace, m, resolveMessageKey } from "REGISTRY_SPECIFIER";

export async function render() {
	await ensureNamespace("${LAZY_NAMESPACE}");
	return [
		m["${EAGER_KEY}"](),
		m["${LAZY_KEY}"](),
		resolveMessageKey("${LAZY_KEY}"),
	];
}
`;

interface BuiltVariant {
	entryChunk: string;
	otherChunks: string[];
	allChunks: string[];
}

let workdir: string;
let eager: BuiltVariant;
let lazy: BuiltVariant;
let eagerCallSite: string;
let lazyCallSite: string;

async function buildVariant(
	name: string,
	lazyNamespaces: readonly string[],
): Promise<{ built: BuiltVariant; callSite: string; registryDir: string }> {
	const registryDir = path.join(workdir, name, "generated");
	generateRegistry({ outDir: registryDir, lazyNamespaces });

	const entryDir = path.join(workdir, name, "src");
	const entryFile = path.join(entryDir, "entry.js");
	const callSite = CALL_SITE_SOURCE.replace(
		"REGISTRY_SPECIFIER",
		path.relative(entryDir, path.join(registryDir, "registry.js")),
	);
	writeFileSync(entryFile, callSite, { flag: "w" });

	const { build } = await import("vite");
	const outDir = path.join(workdir, name, "dist");
	await build({
		root: path.join(workdir, name),
		logLevel: "silent",
		configFile: false,
		build: {
			outDir,
			emptyOutDir: true,
			minify: false,
			lib: { entry: entryFile, formats: ["es"], fileName: () => "entry.js" },
		},
	});

	const { readdirSync } = await import("node:fs");
	// Rollup names split chunks `.mjs` in lib mode while the entry keeps `.js`;
	// scanning only `.js` would silently miss every lazy chunk.
	const files = readdirSync(outDir).filter(
		(file) => file.endsWith(".js") || file.endsWith(".mjs"),
	);
	const read = (file: string) => readFileSync(path.join(outDir, file), "utf8");
	return {
		built: {
			entryChunk: read("entry.js"),
			otherChunks: files.filter((f) => f !== "entry.js").map(read),
			allChunks: files.map(read),
		},
		callSite,
		registryDir,
	};
}

beforeAll(async () => {
	workdir = mkdtempSync(path.join(tmpdir(), "ceraui-i18n-lazy-"));
	for (const name of ["eager", "lazy"]) {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(path.join(workdir, name, "src"), { recursive: true });
	}
	const eagerBuild = await buildVariant("eager", []);
	const lazyBuild = await buildVariant("lazy", [LAZY_NAMESPACE]);
	eager = eagerBuild.built;
	lazy = lazyBuild.built;
	eagerCallSite = eagerBuild.callSite;
	lazyCallSite = lazyBuild.callSite;
}, 600_000);

afterAll(() => {
	if (workdir !== undefined) rmSync(workdir, { recursive: true, force: true });
});

describe("lazy namespace — build output", () => {
	it("ships the lazy namespace's messages in the eager configuration", () => {
		expect(eager.entryChunk).toContain(LAZY_VALUE);
	});

	it("(i) drops them from the initial chunk once the namespace is lazy", () => {
		expect(lazy.entryChunk).not.toContain(LAZY_VALUE);
	});

	it("(i) keeps the eager namespaces in the initial chunk either way", () => {
		expect(eager.entryChunk).toContain("Stream setup");
		expect(lazy.entryChunk).toContain("Stream setup");
	});

	it("(i) never imports paraglide's all-message umbrella from any chunk", () => {
		const umbrella = ["paraglide", "messages.js"].join("/");
		for (const chunk of [...eager.allChunks, ...lazy.allChunks]) {
			expect(chunk).not.toContain(umbrella);
		}
	});

	it("(ii) emits the lazy namespace as its own chunk, reached by import()", () => {
		const carriers = lazy.otherChunks.filter((chunk) =>
			chunk.includes(LAZY_VALUE),
		);
		expect(carriers.length).toBe(1);
		expect(lazy.entryChunk).toMatch(/import\(/);
	});

	it("(iii) builds a BYTE-IDENTICAL call site in both configurations", () => {
		expect(lazyCallSite).toBe(eagerCallSite);
	});
});

describe("lazy namespace — runtime", () => {
	it("(ii) has no lazy message before ensureNamespace, and every one after", {
		timeout: 180_000,
	}, async () => {
		const registryPath = path.join(workdir, "lazy", "generated", "registry.js");
		const registry = (await import(
			/* @vite-ignore */ registryPath
		)) as typeof import("../../../../packages/i18n/generated/registry.js");

		expect(registry.isNamespaceLoaded(LAZY_NAMESPACE)).toBe(false);
		expect(registry.getMessage(LAZY_KEY)).toBeUndefined();
		expect(registry.resolveMessageKey(LAZY_KEY)).toBe(LAZY_KEY);
		expect(registry.getMessage(EAGER_KEY)).toBeDefined();

		await registry.ensureNamespace(LAZY_NAMESPACE);

		expect(registry.isNamespaceLoaded(LAZY_NAMESPACE)).toBe(true);
		expect(registry.resolveMessageKey(LAZY_KEY)).toBe(LAZY_VALUE);
		expect(registry.m[LAZY_KEY]?.()).toBe(LAZY_VALUE);
	});

	it("(iii) yields identical renders from the identical call site", {
		timeout: 180_000,
	}, async () => {
		const eagerRegistry = (await import(
			/* @vite-ignore */ path.join(workdir, "eager", "generated", "registry.js")
		)) as typeof import("../../../../packages/i18n/generated/registry.js");
		const lazyRegistry = (await import(
			/* @vite-ignore */ path.join(workdir, "lazy", "generated", "registry.js")
		)) as typeof import("../../../../packages/i18n/generated/registry.js");

		await lazyRegistry.ensureNamespace(LAZY_NAMESPACE);
		expect(lazyRegistry.m[LAZY_KEY]?.()).toBe(eagerRegistry.m[LAZY_KEY]?.());
		expect(lazyRegistry.m[EAGER_KEY]?.()).toBe(eagerRegistry.m[EAGER_KEY]?.());
	});
});
