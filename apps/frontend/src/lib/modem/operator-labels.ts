/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The SHARED operator display formatters for USB-composition modes and radio
 * bands — `DESIGN.md` §3 (OL-1 … OL-5) in code.
 *
 * Both vocabularies are ENGINE tokens. `rndis` names a Microsoft protocol,
 * `eutran-3` names a 3GPP band table row, and neither says anything an operator
 * can act on. The house rule the rest of this surface already follows — an
 * engine token is never rendered raw, it is keyed to copy (`configChangeReport`,
 * `routerAdminOpenReasonKey`, `fccUnlockErrorKey`) — had two remaining holes,
 * and they were the two most visible ones: the USB-mode card printed the wire
 * token as the operator's ACTIVE MODE, and the band-lock chips printed the wire
 * token as the label an operator clicks to change their radio.
 *
 * Three properties are load-bearing:
 *
 *  - **The raw value is RELOCATED, never deleted (OL-3).** Every formatter here
 *    hands the caller a `raw` token back precisely so a diagnostics block can
 *    keep printing it. A field engineer loses nothing; an operator reads a
 *    behaviour instead of a protocol name.
 *  - **An unmapped token is NEVER printed raw as a fallback (OL-5).** The band
 *    grammar is deliberately open — `bandNameSchema` is a SHAPE check, because
 *    the modem is the authority on which bands it advertises and an enum here
 *    would silently drop a band a newer daemon reports. So an unrecognised token
 *    is a real, expected case, and it resolves to honest generic copy plus the
 *    diagnostics pointer, exactly like an unmapped `config-change` reason.
 *  - **Translation is INJECTED, so this module stays pure and rune-free.** The
 *    unit gate can therefore drive every formatter against the REAL ten-locale
 *    catalog and assert the raw token never reaches the rendered string — a fake
 *    `t` would only prove the key was chosen, not that the copy behind it is
 *    clean.
 */

import type { UsbCompositionMode } from "@ceraui/rpc/schemas";

/** The catalog lookup, injected. Mirrors `m[key](params)` / `resolveMessageKey`. */
export type TranslateLabel = (
	key: string,
	params?: Readonly<Record<string, string>>,
) => string;

// ── Is it the DEVICE's word, or the WIRE's? ──────────────────────────────────

/**
 * A wire token: all lowercase, no spaces, at least one `-`/`_` separator.
 *
 * Several fields on `modemSchema` are `z.string()` carrying whichever of the two
 * their producer happened to have. `status.network_type` is the clearest case —
 * the backend folds a RECOGNISED ModemManager access technology into a display
 * string ("4G", "3G+") and passes an unrecognised one through VERBATIM
 * (`mmConvertAccessTech` returns `accessTechs[0]`), so the same field is "4G" on
 * one modem and `hspa-plus` on the next. A router dongle's own `network_type`
 * has the same two shapes for the same reason, one dialect apart.
 *
 * So the surface cannot ask "is this field a token" — only "is THIS VALUE one".
 * Anchored, so a value that merely CONTAINS a separator (a URL, an opaque
 * `platform-…:2` key, a sentence, an operator's own hyphenated SSID with a
 * capital in it) is not one.
 *
 * ── AND IT IS DELIBERATELY LOWERCASE-ONLY ───────────────────────────────────
 *
 * Every vocabulary this module relocates is lowercase (`ecm-ncm`, `eutran-3`,
 * `hspa-plus`, `router-ethernet`), while the strings that legitimately reach an
 * operator with a hyphen in them are device DISPLAY names and vendor table rows
 * that are not — `RM530N-GL`, `LTE_BAND_3`, `NO SERVICE`. Widening to any case
 * would hide a modem's own product name, which is the one string on the row that
 * MUST render verbatim.
 *
 * IT IS NOT A GENERAL-PURPOSE TEST, and must not be pointed at a value the
 * OPERATOR chose. A hotspot SSID is lowercase user text and may legitimately
 * carry a hyphen; rerouting it into diagnostics would hide the operator's own
 * setting from them. Only device-generated vocabularies are asked.
 */
const MACHINE_IDENTIFIER_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/;

export function isMachineIdentifier(value: string): boolean {
	return MACHINE_IDENTIFIER_RE.test(value.trim());
}

// ── USB composition mode ─────────────────────────────────────────────────────

/**
 * Operator copy names the BEHAVIOUR, never the protocol (OL-1).
 *
 * The five wire values collapse onto three behaviours an operator can actually
 * reason about — the board drives the radio, the device presents a network
 * adapter, or the device is its own router — and the two pairs that share a
 * behaviour keep a qualifier so a switch target list stays unambiguous. None of
 * the copy behind these keys contains a wire token.
 */
export const USB_MODE_LABEL_KEY = {
	qmi: "network.modem.usbMode.mode.qmi",
	mbim: "network.modem.usbMode.mode.mbim",
	"ecm-ncm": "network.modem.usbMode.mode.ecmNcm",
	rndis: "network.modem.usbMode.mode.rndis",
	"router-ethernet": "network.modem.usbMode.mode.routerEthernet",
} as const satisfies Record<UsbCompositionMode, string>;

/** Every wire token this vocabulary can emit — the DOM/grep gate's subject. */
export const USB_MODE_RAW_TOKENS: readonly UsbCompositionMode[] = Object.keys(
	USB_MODE_LABEL_KEY,
) as UsbCompositionMode[];

export function usbModeLabelKey(mode: UsbCompositionMode): string {
	return USB_MODE_LABEL_KEY[mode];
}

/**
 * The operator-facing name of a composition.
 *
 * An ABSENT mode is "Unknown" — the pre-existing behaviour, and the honest one:
 * a modem that reported no composition is not a modem in some default one.
 */
export function usbModeOperatorLabel(
	mode: UsbCompositionMode | undefined,
	t: TranslateLabel,
): string {
	return mode === undefined
		? t("network.modem.usbMode.unknown")
		: t(USB_MODE_LABEL_KEY[mode]);
}

// ── Radio bands ──────────────────────────────────────────────────────────────

/**
 * The four generations a band token can name. These are the i18n KEY segments,
 * not operator copy — the copy behind them is "2G" … "5G", which is what an
 * operator reads on a phone and on a carrier's coverage map.
 */
export const BAND_GENERATION_KEY = {
	gsm: "network.modem.bands.generation.gsm",
	umts: "network.modem.bands.generation.umts",
	lte: "network.modem.bands.generation.lte",
	nr: "network.modem.bands.generation.nr",
} as const;

export type BandGeneration = keyof typeof BAND_GENERATION_KEY;

export type ParsedBand =
	/** The reset value — "let the modem choose". */
	| { readonly kind: "any" }
	/** A 3GPP band NUMBER within a generation. */
	| {
			readonly kind: "numbered";
			readonly generation: BandGeneration;
			readonly band: string;
	  }
	/** A legacy 2G band that is named by its FREQUENCY, not by a number. */
	| {
			readonly kind: "frequency";
			readonly generation: BandGeneration;
			readonly frequency: string;
	  }
	/** Nothing this build recognises. Never printed raw (OL-5). */
	| { readonly kind: "unmapped" };

/** The reset value, mirrored from `@ceraui/rpc` so this module stays leaf-pure. */
const ANY_BAND = "any";

/**
 * The named 2G bands. ModemManager reports these by their GSM name rather than
 * by a number, so a numeric grammar cannot reach them — and rendering "2G band
 * dcs" would be the raw token with a prefix glued on, which is the same leak.
 */
const NAMED_2G_FREQUENCY: Readonly<Record<string, string>> = {
	g850: "850 MHz",
	egsm: "900 MHz",
	pgsm: "900 MHz",
	rgsm: "900 MHz",
	dcs: "1800 MHz",
	pcs: "1900 MHz",
};

/**
 * The numbered-band grammars, in match order.
 *
 * ORDER IS LOAD-BEARING: `ngran-78` starts with `n`, so the bare `n<number>` 5G
 * spelling has to be tried AFTER the explicit `ngran-` family or it would parse
 * the wrong number out of the same token.
 */
const NUMBERED_BAND_GRAMMARS: readonly {
	readonly re: RegExp;
	readonly generation: BandGeneration;
}[] = [
	{ re: /^ngran-(\d{1,3})$/, generation: "nr" },
	{ re: /^eutran-(\d{1,3})$/, generation: "lte" },
	{ re: /^utran-(\d{1,3})$/, generation: "umts" },
	{ re: /^geran-(\d{1,3})$/, generation: "gsm" },
	{ re: /^nr-n?(\d{1,3})$/, generation: "nr" },
	{ re: /^lte-b?(\d{1,3})$/, generation: "lte" },
	{ re: /^umts-(\d{1,3})$/, generation: "umts" },
	{ re: /^n(\d{1,3})$/, generation: "nr" },
	{ re: /^b(\d{1,3})$/, generation: "lte" },
];

/**
 * Read a wire band token into the parts operator copy is built from.
 *
 * Case-insensitive because the same band reaches this surface as `B20` from one
 * stack and `b20` from another, and an operator label that changed with the
 * producer's capitalisation would be a second vocabulary by accident.
 */
export function parseBandToken(token: string): ParsedBand {
	const normalized = token.trim().toLowerCase();
	if (normalized === ANY_BAND) return { kind: "any" };

	const frequency = NAMED_2G_FREQUENCY[normalized];
	if (frequency !== undefined) {
		return { kind: "frequency", generation: "gsm", frequency };
	}

	for (const { re, generation } of NUMBERED_BAND_GRAMMARS) {
		const match = re.exec(normalized);
		// A band NUMBER of zero is not a band in any 3GPP table, so a token that
		// parses to one is a token we did not actually understand.
		if (match?.[1] !== undefined && Number(match[1]) > 0) {
			return { kind: "numbered", generation, band: String(Number(match[1])) };
		}
	}

	return { kind: "unmapped" };
}

/** Whether a token resolves to real operator copy, or falls back to the generic. */
export function isMappedBandToken(token: string): boolean {
	return parseBandToken(token).kind !== "unmapped";
}

/**
 * The operator-facing name of one band.
 *
 * Interpolation goes through the catalog (never `${a} ${b}`) so an RTL or CJK
 * locale can order the generation and the number for itself.
 */
export function bandOperatorLabel(token: string, t: TranslateLabel): string {
	const parsed = parseBandToken(token);
	switch (parsed.kind) {
		case "any":
			// The reset value already had proven operator copy before this module
			// existed; a second phrase for it would be a second vocabulary.
			return t("network.modem.bands.any");
		case "numbered":
			return t("network.modem.bands.label.numbered", {
				generation: t(BAND_GENERATION_KEY[parsed.generation]),
				band: parsed.band,
			});
		case "frequency":
			return t("network.modem.bands.label.frequency", {
				generation: t(BAND_GENERATION_KEY[parsed.generation]),
				frequency: parsed.frequency,
			});
		case "unmapped":
			return t("network.modem.bands.label.unmapped");
	}
}

/**
 * A band SET as operator copy — the "currently locked to …" line.
 *
 * Joining a LIST with a separator is not sentence construction: each element is
 * itself a catalog-resolved phrase, and the sentence around the list is one
 * interpolated message. An EMPTY set answers `undefined` rather than an empty
 * string, so a caller renders the unlocked line instead of a dangling sentence.
 */
export function bandListOperatorLabel(
	tokens: readonly string[],
	t: TranslateLabel,
): string | undefined {
	if (tokens.length === 0) return undefined;
	return tokens.map((token) => bandOperatorLabel(token, t)).join(", ");
}

/**
 * The raw tokens a diagnostics block must keep showing (OL-3).
 *
 * Returned verbatim and in the device's own order — a diagnostics value that has
 * been tidied is no longer the thing the field engineer needs to compare against
 * a vendor table.
 */
export function bandDiagnosticTokens(
	tokens: readonly string[],
): readonly string[] {
	return tokens.filter((token) => token.trim().length > 0);
}

// ── Radio access technology ──────────────────────────────────────────────────

/**
 * The access technology as an operator may read it, or `undefined` when there
 * is nothing sayable.
 *
 * The backend already owns the translation — `accessTechToGen` folds a
 * recognised technology into "2G" … "5G", which is the vocabulary an operator
 * shares with their carrier and is locale-invariant. This is therefore a GUARD
 * rather than a second table: re-mapping here would be a competing vocabulary,
 * and the two could then disagree about one modem.
 *
 * `undefined` is the OL-5 answer for a token the backend could not fold. The
 * caller renders nothing in its place and the raw value is relocated to the
 * diagnostics block (OL-3) — never printed with a prefix glued on, which is the
 * same leak one word longer.
 */
export function accessTechnologyDisplay(
	value: string | undefined,
): string | undefined {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "" || isMachineIdentifier(trimmed)) return undefined;
	return trimmed;
}

// ── Network mode (the operator-settable allowed set) ─────────────────────────

/**
 * `5g4g` → `5G / 4G`. mmcli builds a mode label by sorting the allowed set and
 * joining it with no separator, and both shipped producers reproduce that
 * grammar exactly (`modeMaskToLabel` says so in as many words), so this is the
 * spelling the selector has always rendered.
 */
export function formatGenerationRun(value: string): string {
	return value
		.replace(/(\d+g)/gi, (match) => match.toUpperCase())
		.split(/(?<=G)(?=\d)/)
		.join(" / ");
}

/**
 * The operator's word for one entry of `network_type.supported`.
 *
 * `network_type` is `z.string()` on both halves of the wire and the MODEM is the
 * authority on which modes it advertises — the same openness `bandNameSchema`
 * has, and the same consequence: a label this build does not recognise is an
 * expected case, not a defect. A machine identifier therefore takes the
 * POSITIONAL label the router dongle's own unnamed modes already take (OL-2),
 * and its raw spelling is relocated to diagnostics (OL-3) rather than dropped.
 *
 * Every label either shipped producer emits is a generation run, so this is
 * byte-identical to the previous rendering on every device in the fleet.
 */
export function networkModeOperatorLabel(
	value: string,
	index: number,
	t: TranslateLabel,
): string {
	const trimmed = value.trim();
	if (trimmed === "") return "";
	if (!isMachineIdentifier(trimmed)) return formatGenerationRun(trimmed);
	return t("network.modem.networkMode.unnamed", { index: String(index + 1) });
}
