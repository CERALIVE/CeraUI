/**
 * The boot/destination split is only safe while it stays TOTAL: a namespace in
 * neither set is loaded by nothing, and every string it owns renders as its own
 * dotted key wherever it is read. These gates fail the build on that, and on a
 * quiet re-fusion of the heavyweight namespaces back into the boot await.
 */
import { NAMESPACES } from "@ceraui/i18n/svelte";
import { describe, expect, it } from "vitest";

import {
	BOOT_NAMESPACES,
	DESTINATION_NAMESPACES,
	orphanNamespaces,
} from "$lib/i18n/namespace-activation";

const DESTINATION_KEYS = ["live", "network", "settings", "devtools"] as const;

describe("i18n namespace activation", () => {
	it("covers every namespace the catalog defines", () => {
		expect(orphanNamespaces()).toEqual([]);
	});

	it("names only namespaces that exist", () => {
		const known = new Set<string>(NAMESPACES);
		const referenced = [
			...BOOT_NAMESPACES,
			...Object.values(DESTINATION_NAMESPACES).flat(),
		];
		expect(referenced.filter((ns) => !known.has(ns))).toEqual([]);
	});

	it("defers every namespace claimed by a non-default destination", () => {
		for (const ns of [
			"advanced",
			"devtools",
			"hotspotConfigurator",
			"wifiSelector",
		]) {
			expect(BOOT_NAMESPACES).not.toContain(ns);
		}
	});

	it("boots everything first paint can read", () => {
		// Auth gate, layout chrome + banners, nav, HUD, toasts, PWA/offline, shared
		// dialog chrome, the shell stores that render copy of their own — and the
		// DEFAULT destination's own view, which renders in the same paint.
		for (const ns of [
			"a11y",
			"auth",
			"connection",
			"dialogs",
			"errorBoundary",
			"hud",
			"live",
			"navigation",
			"network",
			"notifications",
			"offline",
			"pwa",
			"settings",
			"updatingOverlay",
		]) {
			expect(BOOT_NAMESPACES).toContain(ns);
		}
	});

	it("claims nothing for the default destination — it boots with the shell", () => {
		expect(DESTINATION_NAMESPACES.live).toEqual([]);
	});

	it("gives every real destination an entry", () => {
		for (const key of DESTINATION_KEYS) {
			expect(DESTINATION_NAMESPACES[key]).toBeDefined();
		}
	});

	it("lists no boot namespace redundantly under a destination", () => {
		const boot = new Set<string>(BOOT_NAMESPACES);
		for (const [key, list] of Object.entries(DESTINATION_NAMESPACES)) {
			expect({ [key]: list.filter((ns) => boot.has(ns)) }).toEqual({
				[key]: [],
			});
		}
	});
});
