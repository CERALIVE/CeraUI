import { describe, expect, it } from "vitest";

import {
	DEV_ONLY_NAMESPACES,
	devOnlyI18nNamespacePlugin,
	isDevOnlyNamespaceBarrel,
} from "../../vite.i18n";

const BARREL = (namespace: string) =>
	`/repo/packages/i18n/generated/namespaces/${namespace}.js`;

describe("dev-only i18n namespace stubbing", () => {
	it("names devtools, whose only consumers are import.meta.env.DEV-gated", () => {
		expect(DEV_ONLY_NAMESPACES).toEqual(["devtools"]);
	});

	it("recognises a dev-only barrel and nothing else", () => {
		expect(isDevOnlyNamespaceBarrel(BARREL("devtools"))).toBe(true);
		expect(isDevOnlyNamespaceBarrel(BARREL("live"))).toBe(false);
		expect(isDevOnlyNamespaceBarrel(BARREL("settings"))).toBe(false);
		expect(
			isDevOnlyNamespaceBarrel("/repo/src/lib/components/dev-tools/x.svelte"),
		).toBe(false);
	});

	it("empties the barrel in production so the messages are not shipped", () => {
		const load = devOnlyI18nNamespacePlugin(true).load;
		expect(load(BARREL("devtools"))).toBe("export const messages = {};\n");
	});

	it("leaves every other namespace untouched in production", () => {
		const load = devOnlyI18nNamespacePlugin(true).load;
		expect(load(BARREL("live"))).toBeNull();
		expect(load(BARREL("settings"))).toBeNull();
	});

	it("is inert in development, where DevTools is reachable", () => {
		const load = devOnlyI18nNamespacePlugin(false).load;
		expect(load(BARREL("devtools"))).toBeNull();
	});
});
