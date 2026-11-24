/**
 * The out-of-date page notice, as the backend sends it: a page whose bundle has
 * the key reads it in the operator's language, an older one reads `msg`.
 */
import { m, setLocale } from "@ceraui/i18n/svelte";
import { afterEach, expect, it } from "vitest";

import { CATALOGS } from "../../tests/helpers/catalog";
import { resolveNotificationText } from "./notifications.svelte";

// What `sendOutOfDateNotice` puts on the wire (apps/backend ui-build.middleware.ts).
const NOTICE = {
	msg: "This page is out of date. Reload to continue.",
	key: "notifications.uiOutOfDate",
};

afterEach(() => {
	setLocale("en");
});

it("reads the device's own English sentence in English", () => {
	expect(resolveNotificationText(NOTICE, m)).toBe(NOTICE.msg);
	expect(CATALOGS.en.notifications.uiOutOfDate).toBe(NOTICE.msg);
});

it.each(Object.keys(CATALOGS).filter((locale) => locale !== "en"))(
	"reads in %s, not in English",
	(locale) => {
		setLocale(locale);

		const text = resolveNotificationText(NOTICE, m);

		expect(text).toBe(CATALOGS[locale].notifications.uiOutOfDate);
		expect(text).toBeTruthy();
		expect(text).not.toBe(NOTICE.msg);
	},
);

it("falls back to msg in a bundle whose messages lack the key", () => {
	const newer = { ...NOTICE, key: "notifications.aKeyThisBundleLacks" };

	expect(resolveNotificationText(newer, m)).toBe(NOTICE.msg);
});
