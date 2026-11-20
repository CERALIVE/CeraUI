import { describe, expect, it } from "vitest";

import federationConfig from "../../vite.federation.config";
import {
	FEDERATION_EXCLUDED_NAMESPACES,
	federationExcludedI18nNamespacePlugin,
	isFederationExcludedNamespaceBarrel,
} from "../../vite.i18n";

const BARREL = (namespace: string) =>
	`/repo/packages/i18n/generated/namespaces/${namespace}.js`;

const PLUGIN_NAME = "ceraui:federation-excluded-i18n-namespaces";
const EMPTY_BARREL = "export const messages = {};\n";

describe("federation-excluded i18n namespace stubbing", () => {
	it("names the System Logs namespaces, which no federated dialog reads", () => {
		expect(FEDERATION_EXCLUDED_NAMESPACES).toEqual(["systemLogs", "timeline"]);
	});

	it("recognises an excluded barrel and nothing else", () => {
		expect(isFederationExcludedNamespaceBarrel(BARREL("systemLogs"))).toBe(
			true,
		);
		expect(isFederationExcludedNamespaceBarrel(BARREL("timeline"))).toBe(true);
		expect(isFederationExcludedNamespaceBarrel(BARREL("live"))).toBe(false);
		expect(isFederationExcludedNamespaceBarrel(BARREL("notifications"))).toBe(
			false,
		);
		expect(
			isFederationExcludedNamespaceBarrel(
				"/repo/apps/frontend/src/main/system-logs/timeline.js",
			),
		).toBe(false);
	});

	it("empties the excluded barrels so their messages leave the federation bundles", () => {
		const { load } = federationExcludedI18nNamespacePlugin();
		expect(load(BARREL("systemLogs"))).toBe(EMPTY_BARREL);
		expect(load(BARREL("timeline"))).toBe(EMPTY_BARREL);
	});

	it("is registered in the real federation build config, ahead of the Paraglide compiler", () => {
		const plugins = (federationConfig.plugins ?? []).flat(
			Number.POSITIVE_INFINITY,
		) as { name?: unknown; load?: (id: string) => unknown }[];
		const names = plugins.map((plugin) => String(plugin?.name ?? ""));
		const excluded = names.indexOf(PLUGIN_NAME);
		const paraglide = names.findIndex((name) => /paraglide/i.test(name));
		expect(excluded).toBeGreaterThanOrEqual(0);
		expect(paraglide).toBeGreaterThanOrEqual(0);
		expect(excluded).toBeLessThan(paraglide);

		const load = plugins[excluded]?.load;
		expect(load?.(BARREL("systemLogs"))).toBe(EMPTY_BARREL);
		expect(load?.(BARREL("timeline"))).toBe(EMPTY_BARREL);
		expect(load?.(BARREL("live"))).toBeNull();
	});

	it("loads every other namespace barrel normally", () => {
		const { load } = federationExcludedI18nNamespacePlugin();
		for (const namespace of [
			"live",
			"settings",
			"dialogs",
			"notifications",
			"audio",
			"devtools",
		]) {
			expect(load(BARREL(namespace))).toBeNull();
		}
	});
});
