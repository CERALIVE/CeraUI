import { describe, expect, it } from "bun:test";

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { namespaceOf } from "../scripts/generate-registry.js";
import { toSafeModuleId } from "../scripts/message-format.js";

// ---------------------------------------------------------------------------
// FACADE REGISTRY GATE.
//
// The registry is what makes `m["a.b.c"]` work: paraglide's own exports resolve
// bracket access against nothing unless every per-message module has been
// imported, and importing its umbrella `messages.js` to achieve that is what
// makes lazy loading impossible. These tests pin the mapping table against the
// files paraglide really emitted, and pin `resolveMessageKey`'s fallback against
// the legacy per-site resolvers it replaces.
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = join(PACKAGE_ROOT, "generated");

const registry = (await import(
	join(GENERATED, "registry.js")
)) as typeof import("../generated/registry.js");

const { NAMESPACE_MAP } = (await import(join(GENERATED, "namespace-map.js"))) as {
	NAMESPACE_MAP: Record<string, { namespace: string; moduleId: string }>;
};

const catalogKeys = Object.keys(
	JSON.parse(
		readFileSync(join(PACKAGE_ROOT, "messages", "en.json"), "utf8"),
	) as Record<string, unknown>,
).filter((key) => key !== "$schema");

describe("generated namespace map", () => {
	it("covers every catalog key exactly once", () => {
		expect(Object.keys(NAMESPACE_MAP).sort()).toEqual([...catalogKeys].sort());
	});

	it("names a module paraglide actually emitted, for every key", () => {
		const missing = catalogKeys.filter(
			(key) =>
				!existsSync(
					join(
						PACKAGE_ROOT,
						"src",
						"paraglide",
						"messages",
						`${NAMESPACE_MAP[key]?.moduleId}.js`,
					),
				),
		);
		expect(missing).toEqual([]);
	});

	it("mirrors toSafeModuleId and the first-segment namespace rule", () => {
		for (const key of catalogKeys) {
			expect(NAMESPACE_MAP[key]).toEqual({
				namespace: namespaceOf(key),
				moduleId: toSafeModuleId(key),
			});
		}
	});
});

describe("registry bracket access", () => {
	it("resolves a verbatim dotted key", () => {
		expect(registry.m["live.setup.title"]?.()).toBe("Stream setup");
	});

	it("renders an explicit locale without touching global state", () => {
		expect(registry.m["live.setup.title"]?.(undefined, { locale: "ar" })).toBe(
			"إعداد البث",
		);
	});

	it("exposes every catalog key under the all-eager configuration", () => {
		expect(Object.keys(registry.m).length).toBe(catalogKeys.length);
	});
});

describe("resolveMessageKey", () => {
	it("renders a known key", () => {
		expect(registry.resolveMessageKey("live.setup.title")).toBe("Stream setup");
	});

	it("returns an unknown key AS ITSELF — the legacy per-site fallback, verbatim", () => {
		expect(registry.resolveMessageKey("no.such.key")).toBe("no.such.key");
		expect(registry.resolveMessageKey("")).toBe("");
	});

	it("passes params through to the message", () => {
		expect(
			registry.resolveMessageKey("live.setup.linksReady", { count: 5 }),
		).toBe("5 links ready");
		expect(
			registry.resolveMessageKey("live.setup.linksReady", { count: 1 }),
		).toBe("1 link ready");
	});

	it("does not throw when an unknown key is given params", () => {
		expect(registry.resolveMessageKey("no.such.key", { count: 3 })).toBe(
			"no.such.key",
		);
	});
});

describe("namespace loading", () => {
	it("reports every namespace loaded under the all-eager configuration", () => {
		for (const namespace of registry.NAMESPACES) {
			expect(registry.isNamespaceLoaded(namespace)).toBe(true);
		}
	});

	it("resolves ensureNamespace immediately for an eager namespace", async () => {
		await registry.ensureNamespace("live");
		expect(registry.isNamespaceLoaded("live")).toBe(true);
	});

	it("rejects an unknown namespace rather than silently doing nothing", async () => {
		await expect(
			registry.ensureNamespace("not-a-namespace" as never),
		).rejects.toThrow(/Unknown i18n namespace/);
	});
});

describe("no-umbrella-import rule", () => {
	it("keeps paraglide's all-message umbrella out of the generated facade", () => {
		const generatedSources = [
			join(GENERATED, "registry.js"),
			join(GENERATED, "runtime.js"),
			join(GENERATED, "namespace-map.js"),
			join(GENERATED, "loader-config.js"),
			join(GENERATED, "namespaces", "live.js"),
		];
		for (const file of generatedSources) {
			expect(readFileSync(file, "utf8")).not.toContain("paraglide/messages.js");
		}
	});
});
