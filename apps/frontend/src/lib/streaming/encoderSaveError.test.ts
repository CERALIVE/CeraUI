/**
 * The refused save is reported HONESTLY (device-quality-wave3 todo 11a).
 *
 * `streaming.setConfig` RESOLVES with `{success:false}` for a device-truth
 * refusal — it does not throw — so a save path that only wraps the await in
 * try/catch toasts "Saved" over a config the device never accepted. These cases
 * pin the mapping and the 10-locale coverage of the copy it selects.
 */

import type { MessageFn, MessageKey } from "@ceraui/i18n/svelte";
import { describe, expect, it } from "vitest";

import ar from "../../../../../packages/i18n/src/ar/index";
import de from "../../../../../packages/i18n/src/de/index";
import en from "../../../../../packages/i18n/src/en/index";
import es from "../../../../../packages/i18n/src/es/index";
import fr from "../../../../../packages/i18n/src/fr/index";
import hi from "../../../../../packages/i18n/src/hi/index";
import ja from "../../../../../packages/i18n/src/ja/index";
import ko from "../../../../../packages/i18n/src/ko/index";
import ptBR from "../../../../../packages/i18n/src/pt-BR/index";
import zh from "../../../../../packages/i18n/src/zh/index";

import {
	DEVICE_MODE_UNSUPPORTED_ERROR,
	encoderSaveErrorMessage,
} from "./encoderSaveError";

const LOCALES = { ar, de, en, es, fr, hi, ja, ko, "pt-BR": ptBR, zh };

const DEVICE_MODE_COPY = "device mode unsupported copy";
const GENERIC_COPY = "generic save failed copy";

function stubLL(): Readonly<Record<MessageKey, MessageFn>> {
	return {
		"live.encoder.deviceModeUnsupported": () => DEVICE_MODE_COPY,
		"notifications.saveFailed": () => GENERIC_COPY,
	} as unknown as Readonly<Record<MessageKey, MessageFn>>;
}

describe("encoderSaveErrorMessage", () => {
	it("names the CAUSE for a device-truth refusal", () => {
		expect(
			encoderSaveErrorMessage(DEVICE_MODE_UNSUPPORTED_ERROR, stubLL()),
		).toBe(DEVICE_MODE_COPY);
	});

	it("falls back to the generic failure for any other refusal", () => {
		expect(encoderSaveErrorMessage("unknown_source", stubLL())).toBe(
			GENERIC_COPY,
		);
		expect(encoderSaveErrorMessage(undefined, stubLL())).toBe(GENERIC_COPY);
	});

	it("ships both new keys in all 10 locales, with no wire value leaked", () => {
		for (const [locale, translation] of Object.entries(LOCALES)) {
			const refusal = translation.live?.encoder?.deviceModeUnsupported;
			const clamp = translation.notifications?.encoderModeClamped;
			expect(
				typeof refusal,
				`${locale} live.encoder.deviceModeUnsupported`,
			).toBe("string");
			expect(typeof clamp, `${locale} notifications.encoderModeClamped`).toBe(
				"string",
			);
			expect(refusal).not.toContain(DEVICE_MODE_UNSUPPORTED_ERROR);
		}
	});
});
