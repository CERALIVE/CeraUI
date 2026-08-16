/**
 * @vitest-environment jsdom
 *
 * Mounts the BUILT federation bundles — the exact bytes `sign:federation` signs
 * and `publish-federation` uploads to R2 — against the host contract
 * `ceralive-platform` implements.
 *
 * It runs against `dist/federation/<version>/`, so it is NOT part of the default
 * `bun run --filter frontend test` (that suite has no build step and lives under
 * `src/`). Its own entry point is `bun run test:federation-abi`, which builds
 * first. A unit test of the entry SOURCE would prove nothing this proves: the
 * regressions it exists to catch — a bundle whose message catalog got
 * tree-shaken away, or one whose chunk graph no longer resolves standalone —
 * only exist after bundling.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { FEDERATION_ABI_VERSION } from "../../src/lib/federation/host-contract";
import type {
	FederationHostAdapter,
	FederationMountHandle,
	FederationMountOptions,
} from "../../src/lib/federation/host-contract";

const ROOT = resolve(import.meta.dirname, "../../../..");
const VERSION = (
	JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
		version: string;
	}
).version;
const OUTPUT = join(ROOT, "dist", "federation", VERSION);

const ENTRIES = ["encoder", "audio", "server"] as const;

interface FederationModule {
	readonly federationAbiVersion: number;
	mountDialog(
		target: Element,
		options: FederationMountOptions,
	): FederationMountHandle;
}

function hostAdapter(
	overrides: Partial<FederationHostAdapter> = {},
): FederationHostAdapter {
	return {
		setConfig: async () => ({ success: true }),
		validateRelay: async () => ({ ok: true, stages: [] }) as never,
		...overrides,
	} as FederationHostAdapter;
}

async function loadEntry(name: string): Promise<FederationModule> {
	return (await import(
		/* @vite-ignore */ pathToFileURL(join(OUTPUT, `${name}.js`)).href
	)) as FederationModule;
}

/** Svelte flushes mount effects on a microtask, and bits-ui portals its surface. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountInto(
	module: FederationModule,
	options: FederationMountOptions,
): Promise<{ target: HTMLElement; handle: FederationMountHandle }> {
	const target = document.createElement("div");
	document.body.append(target);
	const handle = module.mountDialog(target, options);
	await settle();
	return { target, handle };
}

/** A dotted key that leaked into the DOM instead of rendering as copy. */
const RAW_KEY = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+){2,}$/;

function renderedText(root: ParentNode): string[] {
	return [...root.querySelectorAll("*")]
		.flatMap((element) => [...element.childNodes])
		.filter((node) => node.nodeType === node.TEXT_NODE)
		.map((node) => node.textContent?.trim() ?? "")
		.filter((text) => text.length > 0);
}

beforeAll(() => {
	// jsdom implements neither matchMedia (AppDialog's desktop/mobile split
	// constructs a svelte/reactivity MediaQuery at mount) nor ResizeObserver
	// (bits-ui measures its floating surfaces). Both are environment gaps, not
	// product behaviour — a real browser supplies them.
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	} as unknown as typeof ResizeObserver;
	window.matchMedia = ((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	})) as unknown as typeof window.matchMedia;

	expect(
		readdirSync(OUTPUT),
		`no federation output at ${OUTPUT} — run \`bun run build:federation\` first`,
	).toContain("encoder.js");
});

// bits-ui portals dialog content to <body>, outside the host-owned target, so a
// leftover surface from a previous mount would be indistinguishable from the one
// under test.
afterEach(() => {
	document.body.replaceChildren();
});

describe.each(ENTRIES)("federation bundle %s.js", (name) => {
	it("pins the ABI version the host compiled against", async () => {
		const module = await loadEntry(name);
		expect(module.federationAbiVersion).toBe(1);
		expect(module.federationAbiVersion).toBe(FEDERATION_ABI_VERSION);
	});

	it("mounts into a host-owned element and unmounts cleanly", async () => {
		const module = await loadEntry(name);
		const { target, handle } = await mountInto(module, { host: hostAdapter() });

		expect(target.childElementCount).toBeGreaterThan(0);

		await handle.destroy();
		expect(target.childElementCount).toBe(0);
	});

	it("renders translated copy, never a raw dotted key", async () => {
		const module = await loadEntry(name);
		const { target, handle } = await mountInto(module, { host: hostAdapter() });

		const texts = renderedText(document.body);
		expect(texts.length).toBeGreaterThan(0);
		expect(texts.filter((text) => RAW_KEY.test(text))).toEqual([]);

		await handle.destroy();
	});

	it("renders the host's requested locale", async () => {
		const module = await loadEntry(name);
		const { target, handle } = await mountInto(module, {
			host: hostAdapter(),
			locale: "ar",
		});

		// Arabic script anywhere in the dialog proves the bundle carries the
		// non-base locales AND that the host's `locale` reached its own runtime.
		expect(renderedText(document.body).join(" ")).toMatch(/[\u0600-\u06FF]/);

		await handle.destroy();
	});
});

describe("federation save-failure surface", () => {
	it("surfaces a resolved {success:false} write instead of reporting success", async () => {
		const module = await loadEntry("encoder");
		const failures: string[] = [];
		const { handle } = await mountInto(module, {
			// Explicit: the bundle's locale is module state that survives unmount, so
			// an earlier mount's `ar` would otherwise decide what this asserts.
			locale: "en",
			host: hostAdapter({
				setConfig: async () => {
					failures.push("called");
					return { success: false, error: "device_mode_unsupported" };
				},
			}),
		});

		const save = [...document.querySelectorAll("button")].find((button) =>
			/save|حفظ/i.test(button.textContent ?? ""),
		);
		expect(save, "the encoder dialog renders no save control").toBeDefined();
		save?.click();
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(failures).toEqual(["called"]);
		const catalog = JSON.parse(
			readFileSync(
				join(ROOT, "packages", "i18n", "messages", "en.json"),
				"utf8",
			),
		) as Record<string, string>;
		const expected = catalog["live.encoder.deviceModeUnsupported"];
		expect(expected).toBeTypeOf("string");
		expect(document.body.textContent ?? "").toContain(expected);

		await handle.destroy();
	});
});
