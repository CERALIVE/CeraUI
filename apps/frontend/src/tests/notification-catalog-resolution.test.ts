import { ensureNamespace, LOCALES, m, setLocale } from "@ceraui/i18n/svelte";
import { afterEach, describe, expect, it } from "vitest";

import { resolveNotificationText } from "../lib/stores/notifications.svelte";
import { CATALOGS } from "./helpers/catalog";

afterEach(() => {
	setLocale("en");
});

describe("backend notification resolution through the real message facade", () => {
	for (const { code } of LOCALES) {
		it.each([
			"notifications.updateInstalled",
			"notifications.updateSlotSyncRecovered",
			"notifications.updatesAvailableMessage",
		])(`resolves %s when the active locale is ${code}`, async (key) => {
			// Given the actual generated namespace, not an injected translation map
			await ensureNamespace("notifications");
			setLocale(code);
			const pattern: unknown =
				CATALOGS[code].notifications[key.split(".")[1] ?? ""];
			if (typeof pattern !== "string")
				throw new Error(`Missing catalog key ${key}`);
			// When the notification store resolves backend data at push time
			const actual = resolveNotificationText(
				{ key, msg: "UNTRANSLATED", params: { packages: "fixture-package" } },
				m,
			);
			// Then locale selection and interpolation agree with the source catalog
			expect(actual).toBe(pattern.replace("{packages}", "fixture-package"));
		});
	}
});
