/**
 * The fan reports a DUTY CYCLE, and there is no speed to report.
 *
 * The reference board's fan is 2-wire: its hwmon exposes `pwm1`/`pwm1_enable`
 * and no `fan1_input`, so no tachometer exists anywhere in the stack. A
 * percentage presented as a speed would be a fabricated measurement — the same
 * class of lie the three-state encoder-load model exists to prevent — so no
 * locale may name one, in copy or in a `title`.
 *
 * This sweeps `settings.deviceStats.*` in all ten locales. Two guards keep it
 * from passing vacuously: the detector is proven against planted violations,
 * and every fan key is asserted PRESENT, so a locale that simply lost the copy
 * cannot look clean.
 */
import { describe, expect, it } from "vitest";

import ar from "../../../../packages/i18n/src/ar/index";
import de from "../../../../packages/i18n/src/de/index";
import en from "../../../../packages/i18n/src/en/index";
import es from "../../../../packages/i18n/src/es/index";
import fr from "../../../../packages/i18n/src/fr/index";
import hi from "../../../../packages/i18n/src/hi/index";
import ja from "../../../../packages/i18n/src/ja/index";
import ko from "../../../../packages/i18n/src/ko/index";
import ptBR from "../../../../packages/i18n/src/pt-BR/index";
import zh from "../../../../packages/i18n/src/zh/index";

const LOCALES = { ar, de, en, es, fr, hi, ja, ko, "pt-BR": ptBR, zh };

const TACHOMETER = /\br\.?p\.?m\b|r\/min|revolutions|转\/分|回転数/i;

const FAN_KEYS = [
	"fan",
	"fanCooling",
	"fanOff",
	"fanAbsent",
	"fanAbsentBody",
	"fanHint",
] as const;

function collectStrings(
	value: unknown,
	path: string,
	out: { path: string; text: string }[],
): void {
	if (typeof value === "string") {
		out.push({ path, text: value });
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		collectStrings(child, path === "" ? key : `${path}.${key}`, out);
	}
}

describe("the detector actually detects", () => {
	it.each([
		"Fan speed: 2400 RPM",
		"fan 2400 rpm",
		"Ventilador a 2.400 r.p.m.",
		"1200 r/min",
		"3000 revolutions per minute",
		"转速 2400 转/分",
		"ファン回転数",
	])("flags %j", (planted) => {
		expect(TACHOMETER.test(planted)).toBe(true);
	});

	it("does not flag the legitimate duty-cycle copy", () => {
		expect(TACHOMETER.test(en.settings.deviceStats.fanHint)).toBe(false);
	});
});

describe("no fan copy names a rotational speed", () => {
	it.each(Object.keys(LOCALES))("%s", (locale) => {
		const stats = LOCALES[locale as keyof typeof LOCALES].settings.deviceStats;

		for (const key of FAN_KEYS) {
			expect(
				typeof (stats as Record<string, unknown>)[key],
				`${locale}: settings.deviceStats.${key} is missing`,
			).toBe("string");
		}

		const entries: { path: string; text: string }[] = [];
		collectStrings(stats, "settings.deviceStats", entries);
		expect(entries.length).toBeGreaterThan(FAN_KEYS.length);

		const offenders = entries
			.filter(({ text }) => TACHOMETER.test(text))
			.map(({ path, text }) => `${path}: "${text}"`);
		expect(offenders).toEqual([]);
	});
});
