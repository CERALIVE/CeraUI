/**
 * Locale-aware formatters for CeraUI.
 *
 * Two layers live here:
 *
 * 1. `initFormatters` — the `typesafe-i18n` contract. The generated
 *    `Formatters` type is currently `{}` (no `{value|formatter}` syntax is used
 *    inside translation strings), so this returns an empty object. Keeping the
 *    signature intact means codegen / the generated `i18n-util` keep compiling.
 *
 * 2. Standalone `Intl`-based formatter factories (`formatBitrate`, `formatTemp`,
 *    …). These are the functions components and tests actually call. They take a
 *    locale and return a unit-aware formatting function. They are decoupled from
 *    the translation-interpolation pipeline on purpose: the custom Svelte 5
 *    runes adapter (`i18n-svelte5.svelte.ts`) does plain `{key}` interpolation
 *    and never invokes typesafe-i18n formatters, so wiring these through the
 *    `Formatters` type would buy nothing.
 */

import type { FormattersInitializer } from "typesafe-i18n";
import type { Formatters, Locales } from "./i18n-types.js";

/**
 * A BCP-47 locale tag. We accept the typed `Locales` union as well as any raw
 * string so callers can pass `navigator.language` / `Intl`-resolved tags.
 */
export type LocaleArg = Locales | string;

/** A formatter that turns a numeric (or Date) value into a localized string. */
export type ValueFormatter<T> = (value: T) => string;

/**
 * Network bitrate. Sub-1000 kbps renders as `kbps`; ≥1000 promotes to `Mbps`
 * with at most one fractional digit.
 * @example formatBitrate('en')(850)  // "850 kbps"
 * @example formatBitrate('en')(1500) // "1.5 Mbps"
 */
export const formatBitrate =
	(locale: LocaleArg): ValueFormatter<number> =>
	(kbps: number): string => {
		if (!Number.isFinite(kbps)) return "—";
		if (Math.abs(kbps) >= 1000) {
			const mbps = (kbps / 1000).toLocaleString(locale, {
				maximumFractionDigits: 1,
			});
			return `${mbps} Mbps`;
		}
		return `${Math.round(kbps).toLocaleString(locale)} kbps`;
	};

/**
 * Temperature in degrees Celsius.
 * @example formatTemp('en')(43.2) // "43.2 °C"
 */
export const formatTemp =
	(locale: LocaleArg): ValueFormatter<number> =>
	(celsius: number): string => {
		if (!Number.isFinite(celsius)) return "—";
		return `${celsius.toLocaleString(locale, { maximumFractionDigits: 1 })} °C`;
	};

/**
 * Voltage in volts.
 * @example formatVoltage('en')(12.1) // "12.1 V"
 */
export const formatVoltage =
	(locale: LocaleArg): ValueFormatter<number> =>
	(volts: number): string => {
		if (!Number.isFinite(volts)) return "—";
		return `${volts.toLocaleString(locale, { maximumFractionDigits: 1 })} V`;
	};

/**
 * Current in amperes.
 * @example formatCurrent('en')(2.3) // "2.3 A"
 */
export const formatCurrent =
	(locale: LocaleArg): ValueFormatter<number> =>
	(amperes: number): string => {
		if (!Number.isFinite(amperes)) return "—";
		return `${amperes.toLocaleString(locale, { maximumFractionDigits: 1 })} A`;
	};

/**
 * Binary data size from a byte count. Scales to B/KB/MB/GB/TB (1024-based);
 * sub-KB renders whole bytes, larger units keep one fractional digit.
 * @example formatBytes('en')(1536) // "1.5 KB"
 */
export const formatBytes =
	(locale: LocaleArg): ValueFormatter<number> =>
	(bytes: number): string => {
		if (!Number.isFinite(bytes)) return "—";
		const units = ["B", "KB", "MB", "GB", "TB"] as const;
		let value = Math.abs(bytes);
		let unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit += 1;
		}
		const formatted = value.toLocaleString(locale, {
			maximumFractionDigits: unit === 0 ? 0 : 1,
		});
		return `${bytes < 0 ? "-" : ""}${formatted} ${units[unit]}`;
	};

/**
 * Percentage. Input is a whole-number percent (e.g. `87` → `"87%"`), not a
 * 0–1 ratio.
 * @example formatPercent('en')(87) // "87%"
 */
export const formatPercent =
	(locale: LocaleArg): ValueFormatter<number> =>
	(percent: number): string => {
		if (!Number.isFinite(percent)) return "—";
		return new Intl.NumberFormat(locale, {
			style: "percent",
			maximumFractionDigits: 0,
		}).format(percent / 100);
	};

/**
 * Relative time from `date` to now using `Intl.RelativeTimeFormat`. Falls back
 * to `"just now"` for the most recent few seconds.
 * @example formatRelativeTime('en')(new Date(Date.now() - 120_000)) // "2 minutes ago"
 */
export const formatRelativeTime =
	(locale: LocaleArg): ValueFormatter<Date> =>
	(date: Date): string => {
		const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
		if (!Number.isFinite(seconds)) return "—";
		if (Math.abs(seconds) < 10) return "just now";

		const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
		const abs = Math.abs(seconds);
		const sign = seconds < 0 ? 1 : -1; // future → positive, past → negative

		if (abs < 60) return rtf.format(sign * abs, "second");
		if (abs < 3600) return rtf.format(sign * Math.floor(abs / 60), "minute");
		if (abs < 86_400) return rtf.format(sign * Math.floor(abs / 3600), "hour");
		return rtf.format(sign * Math.floor(abs / 86_400), "day");
	};

/** The full set of value formatters bound to a single locale. */
export interface AppFormatters {
	bitrate: ValueFormatter<number>;
	bytes: ValueFormatter<number>;
	temp: ValueFormatter<number>;
	voltage: ValueFormatter<number>;
	current: ValueFormatter<number>;
	percent: ValueFormatter<number>;
	relativeTime: ValueFormatter<Date>;
}

/**
 * Build a locale-bound bundle of every formatter. Convenient for components
 * that need several formatters for the same locale.
 */
export const createFormatters = (locale: LocaleArg): AppFormatters => ({
	bitrate: formatBitrate(locale),
	bytes: formatBytes(locale),
	temp: formatTemp(locale),
	voltage: formatVoltage(locale),
	current: formatCurrent(locale),
	percent: formatPercent(locale),
	relativeTime: formatRelativeTime(locale),
});

/**
 * typesafe-i18n initializer. `Formatters` is `{}` (no in-string formatter usage),
 * so this returns an empty object — the real formatters are the standalone
 * factories above.
 */
export const initFormatters: FormattersInitializer<Locales, Formatters> = (
	_locale: Locales,
) => {
	const formatters: Formatters = {};

	return formatters;
};
