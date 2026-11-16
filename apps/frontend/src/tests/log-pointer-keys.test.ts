/**
 * THE "VIEW LOGS" ALLOWLIST IS THE CATALOG'S OWN LIST.
 *
 * A message earns the action because its English text sends the operator to
 * Settings → System Logs. The set is derived here from that text, so a new
 * log-pointing message cannot ship without the action and none is listed by
 * mistake.
 */
import { describe, expect, it } from "vitest";

import enCatalog from "../../../../packages/i18n/messages/en.json" with {
	type: "json",
};
import {
	LOG_POINTER_KEYS,
	notificationLogKey,
} from "../lib/device-logs/log-pointer-keys";
import { CATALOGS } from "./helpers/catalog";

const POINTER = "Settings → System Logs";

function pointsToLogs(entry: unknown): boolean {
	return JSON.stringify(entry).includes(POINTER);
}

describe("LOG_POINTER_KEYS", () => {
	it("equals the set of English messages that send the operator to System Logs", () => {
		const derived = Object.entries(enCatalog)
			.filter(([key, entry]) => key !== "$schema" && pointsToLogs(entry))
			.map(([key]) => key)
			.sort();

		expect(derived.length).toBeGreaterThan(0);
		expect([...LOG_POINTER_KEYS].sort()).toEqual(derived);
	});

	it("holds no key that is absent from the catalog", () => {
		for (const key of LOG_POINTER_KEYS) {
			expect(Object.hasOwn(enCatalog, key as string)).toBe(true);
		}
	});
});

describe("notifications.viewLogs", () => {
	it.each(Object.keys(CATALOGS))(
		"is a translated label in %s that never names System Logs",
		(locale) => {
			const catalog = CATALOGS[locale];
			const label: unknown = catalog.notifications.viewLogs;

			expect(typeof label).toBe("string");
			expect((label as string).trim()).not.toBe("");
			// Locators find System Logs by its title as a substring; this label must not match.
			expect(label).not.toContain(catalog.settings.index.logs);
			if (locale !== "en")
				expect(label).not.toBe(CATALOGS.en.notifications.viewLogs);
		},
	);
});

describe("notificationLogKey", () => {
	it("is the notification's own key", () => {
		expect(
			notificationLogKey({ key: "notifications.streamStartInternalFailed" }),
		).toBe("notifications.streamStartInternalFailed");
		expect(notificationLogKey({ key: "notifications.saved" })).toBe(
			"notifications.saved",
		);
		expect(notificationLogKey({})).toBeUndefined();
	});

	it("is a refusal's generic reason sentence, which itself points to the logs", () => {
		const generic = notificationLogKey({
			key: "notifications.updateRefused",
			params: { reason: "apt: E: Sub-process returned an error code" },
		});
		expect(generic).toBe("notifications.updateRefusedGeneric");
		expect(LOG_POINTER_KEYS.has(generic)).toBe(true);
		expect(notificationLogKey({ key: "notifications.updateRefused" })).toBe(
			"notifications.updateRefusedGeneric",
		);
	});

	it("is a refusal's own reason sentence when the reason is known", () => {
		const known = notificationLogKey({
			key: "notifications.updateRefused",
			params: { reason: "captive_portal" },
		});
		expect(known).toBe("settings.updates.checkFailed.captive_portal");
		expect(LOG_POINTER_KEYS.has(known)).toBe(false);
	});
});
