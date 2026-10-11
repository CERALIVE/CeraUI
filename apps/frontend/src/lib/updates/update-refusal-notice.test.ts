// @vitest-environment jsdom
/**
 * A refused-update notice never shows the device's machine token (C-m1).
 *
 * Driven with the exact wire shape `update-orchestrator/notifications.ts`
 * sends (key + `{ reason }`), resolved against the REAL message registry the
 * toast host uses, so a reason that lost its copy would show here.
 */
import { m } from "@ceraui/i18n/svelte";
import type { Notification } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { en } from "../../tests/helpers/catalog";
import { resolveNotificationText } from "../stores/notifications.svelte";
import { updateRefusalReasonKey } from "./update-refusal-notice";

function refusedNotice(reason: string): Notification {
	return {
		name: `update:refused:os-check:${reason}`,
		type: "warning",
		msg: "notifications.updateRefused",
		is_dismissable: true,
		is_persistent: true,
		duration: 0,
		key: "notifications.updateRefused",
		params: { reason },
	};
}

describe("refused-update notices (C-m1)", () => {
	it("reads booted_version_unknown as its localized sentence, never the token", () => {
		// Given the notice the OS check raises when the running version is unknown.
		const notice = refusedNotice("booted_version_unknown");

		// When the toast host resolves it.
		const text = resolveNotificationText(notice, m);

		// Then the operator reads the sentence, not the machine token.
		expect(text).toBe(
			`Update refused. ${en.settings.updates.refusal.bootedVersionUnknown}`,
		);
		expect(text).not.toContain("booted_version_unknown");
	});

	it("reads an unknown diagnostic as copy that points at the logs", () => {
		// Given a refusal carrying a raw apt line.
		const notice = refusedNotice(
			"E: dpkg was interrupted, run dpkg --configure -a",
		);

		// When it is resolved.
		const text = resolveNotificationText(notice, m);

		// Then the diagnostic stays off screen.
		expect(text).toBe(
			`Update refused. ${en.notifications.updateRefusedGeneric}`,
		);
		expect(text).not.toContain("dpkg");
	});

	it("maps every known reason to copy of its own and nothing else to it", () => {
		for (const reason of [
			"booted_version_unknown",
			"captive_portal",
			"repos_unreachable",
			"refresh_failed",
			"discovery_failed",
		])
			expect(updateRefusalReasonKey(reason)).not.toBe(
				"notifications.updateRefusedGeneric",
			);
		for (const reason of ["toString", "constructor", "", undefined, 42])
			expect(updateRefusalReasonKey(reason)).toBe(
				"notifications.updateRefusedGeneric",
			);
	});

	it("leaves every other notice's params untouched", () => {
		// Given a notice whose params are display text already.
		const notice: Notification = {
			...refusedNotice("unused"),
			key: "notifications.updateSystemStaged",
			params: { version: "2026.10.76" },
		};

		// Then they interpolate verbatim.
		expect(resolveNotificationText(notice, m)).toContain("2026.10.76");
	});
});
