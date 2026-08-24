/**
 * A config dialog reaches a mount site through the registry, or not at all.
 *
 * `lazyDialog()` + `<LazyDialog>` keeps each config dialog in its own chunk, but
 * the split is a property of the WHOLE graph rather than of the call site: one
 * surviving static import anywhere fuses the component back into the entry chunk
 * and silently neuters every `import()` of it elsewhere. Rolldown says so
 * (`INEFFECTIVE_DYNAMIC_IMPORT`) and then builds successfully, so nothing failed.
 *
 * That is exactly how it went wrong: `NetworkView` registered `HotspotDialog`
 * lazily while `WifiSection` still imported it statically for its per-radio
 * configurator, so the registration bought nothing for an entire effort.
 *
 * TWO exemptions, both deliberate:
 *  - `src/main/dialogs/**` — a dialog composing its own sub-components.
 *  - `src/lib/federation/*-entry.ts` — a hosted bundle is fetched as ONE module
 *    against a signed manifest pinning an exact chunk graph, so its import graph
 *    must stay statically complete (`apps/frontend/AGENTS.md` → federation).
 *
 * A TYPE-only import is always fine: it is erased at compile time and creates no
 * runtime edge, which is the documented split for a dialog that also exports a
 * type.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

/**
 * A VALUE import of a `main/dialogs/…Dialog.svelte` module.
 *
 * `import type` is excluded by the negative lookahead, and the specifier arms
 * cover all three spellings in the tree: the `$main` alias, and `./`/`../`
 * relatives. `$lib/components/dialogs/AppDialog.svelte` (the shared chrome every
 * dialog composes) is not a config dialog and is deliberately unmatched.
 */
const STATIC_DIALOG_IMPORT =
	/^import\s+(?!type\s)[^;]*?from\s*['"](?:\$main|\.\.?)\/dialogs\/\w*Dialog\.svelte['"]/gm;

const EXEMPT_DIRS = [
	path.join(SRC, "main", "dialogs"),
	path.join(SRC, "lib", "federation"),
];

function shippedSources(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "node_modules" || EXEMPT_DIRS.includes(full)) continue;
			found.push(...shippedSources(full));
			continue;
		}
		if (!/\.(svelte|ts)$/.test(entry)) continue;
		if (/\.(test|spec)\./.test(entry)) continue;
		found.push(full);
	}
	return found;
}

function offenders(): string[] {
	const hits: string[] = [];
	for (const file of shippedSources(SRC)) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(STATIC_DIALOG_IMPORT)) {
			hits.push(`${path.relative(SRC, file)}: ${match[0].trim()}`);
		}
	}
	return hits;
}

describe("config dialogs load through the registry, never a static import", () => {
	it("finds no static dialog import outside the two exempt trees", () => {
		const scanned = shippedSources(SRC);

		// The walk must actually reach the file that regressed, or an empty
		// verdict below would only mean the scanner found nothing.
		expect(scanned).toContain(
			path.join(SRC, "main", "network", "WifiSection.svelte"),
		);
		expect(scanned.length).toBeGreaterThan(100);

		expect(offenders()).toEqual([]);
	});

	it("detects the import shape it is meant to catch", () => {
		const planted = [
			`import HotspotDialog from '../dialogs/HotspotDialog.svelte';`,
			`import NetifDialog from "./dialogs/NetifDialog.svelte";`,
			`import EncoderDialog from "$main/dialogs/EncoderDialog.svelte";`,
		];

		for (const line of planted) {
			expect(line.match(STATIC_DIALOG_IMPORT)).toHaveLength(1);
		}
	});

	it("leaves a type-only import and the shared dialog chrome alone", () => {
		const allowed = [
			`import type { EncoderConfig } from '$main/dialogs/EncoderDialog.svelte';`,
			`import AppDialog from '$lib/components/dialogs/AppDialog.svelte';`,
			`const D = lazyDialog(() => import('../dialogs/HotspotDialog.svelte'));`,
		];

		for (const line of allowed) {
			expect(line.match(STATIC_DIALOG_IMPORT)).toBeNull();
		}
	});
});
