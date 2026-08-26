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

import type {
	ModemOperationCompletionStatus,
	ModemOperationOutcome,
	ModemOperationResultStatus,
	ModemOperationUnknownReason,
	UsbCompositionMode,
} from "@ceraui/rpc/schemas";
import { MODEM_MANAGER_REFUSAL_RETRYABLE } from "@ceraui/rpc/schemas";

import {
	type MutationOutcome,
	type MutationOutcomeDetail,
	type MutationOutcomeKind,
	mutationOutcome,
} from "./mutation-outcome";

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

// ── What a modem OPERATION did once it was admitted ──────────────────────────
//
// `@ceralive/modem-control` classifies every operation TWICE — into a COMPLETION
// (what the provider reported) and into a RESULT (what that means after
// generation fencing) — plus a typed reason for the one result that is neither a
// success nor a failure. Twelve values in three enums, mirrored onto the wire by
// `modemOperationOutcomeSchema` and rendered here.
//
// THREE PROPERTIES ARE LOAD-BEARING, and every one of them is a lie waiting to
// happen if it is "simplified":
//
//  1. **THE COMPLETION IS RENDERED BESIDE THE RESULT, NEVER INSTEAD OF IT.**
//     `timed-out` is the forcing case: on a WRITE it classifies as
//     `unknown-outcome` (the call may have landed) and on a READ as plain
//     `failed` (nothing changed). One completion, two operator situations, two
//     different next actions. Collapsing the pair onto one sentence destroys
//     exactly the distinction the split enum exists to carry — so the same
//     completion renders in two visibly different bands, and a test pins both.
//  2. **`unknown-outcome` IS NEITHER A SUCCESS NOR A FAILURE, EVER.** It maps to
//     the band's `unknown` kind and carries the EXISTING mutation-block
//     reconciliation sentence — the surface a device in that state genuinely is
//     on, since the journal holds it fail-closed until an operator confirms what
//     the hardware is actually in. It never maps to `applied` or `refused`, and
//     it never offers a retry: re-issuing a write whose fate is unknown is how a
//     half-applied change becomes a doubly-applied one.
//  3. **A RETRY IS SUGGESTED ONLY WHERE THE PACKAGE SAYS ONE COULD HELP.** The
//     gate is `MODEM_MANAGER_REFUSAL_RETRYABLE` for a typed daemon refusal and
//     the wire's own `retryable` otherwise; nothing here re-derives it from a
//     reason NAME. Suggesting a retry for `unauthorized` or `unsupported` spends
//     an operator's time on a verdict that cannot move.
//
// Copy is keyed, never composed from a wire token (OL-5): the twelve values are
// `applied`/`refused`/`failed`/`timed-out`/`dropped` and friends, which are
// machine identifiers by `isMachineIdentifier`'s own test.

/**
 * What the PROVIDER reported. Five values, one key each.
 *
 * A TOTAL record rather than a lookup with a fallback: a sixth completion status
 * fails `tsc` here instead of reaching an operator as a dotted path.
 */
export const MODEM_OPERATION_COMPLETION_KEY = {
	applied: "network.modem.operation.completion.applied",
	refused: "network.modem.operation.completion.refused",
	failed: "network.modem.operation.completion.failed",
	"timed-out": "network.modem.operation.completion.timedOut",
	dropped: "network.modem.operation.completion.dropped",
} as const satisfies Record<ModemOperationCompletionStatus, string>;

/** What the classifier ANSWERED. Four values, one key each. Total. */
export const MODEM_OPERATION_RESULT_KEY = {
	applied: "network.modem.operation.result.applied",
	refused: "network.modem.operation.result.refused",
	"unknown-outcome": "network.modem.operation.result.unknownOutcome",
	failed: "network.modem.operation.result.failed",
} as const satisfies Record<ModemOperationResultStatus, string>;

/** The three — and only three — ways an outcome becomes unknowable. Total. */
export const MODEM_OPERATION_UNKNOWN_REASON_KEY = {
	"stale-generation": "network.modem.operation.unknown.staleGeneration",
	"write-reply-timed-out": "network.modem.operation.unknown.writeReplyTimedOut",
	"write-reply-dropped": "network.modem.operation.unknown.writeReplyDropped",
} as const satisfies Record<ModemOperationUnknownReason, string>;

/**
 * The reconciliation pointer, and it is deliberately the EXISTING mutation-block
 * sentence rather than a new one.
 *
 * A device carrying an unknown outcome IS mutation-blocked — the journal holds
 * it fail-closed until an operator confirms what the hardware is in — so this is
 * not a second, parallel "unknown state" concept but the one that already
 * exists, said in the words it already has. Mirrored as a literal for the reason
 * `ANY_BAND` is (this module stays leaf-pure); `operator-labels.test.ts` pins it
 * against `refusalCopyKey("reconciliation-required")`, so the two cannot drift.
 */
export const MODEM_OPERATION_RECONCILIATION_KEY =
	"network.modem.refusal.reconciliationRequired";

/** The retry hint. Rendered ONLY where {@link modemOperationRetrySuggested} says so. */
export const MODEM_OPERATION_RETRY_KEY =
	"network.modem.operation.retrySuggested";

/** The pure reading of one wire outcome, in i18n KEYS. Never sentences. */
export interface ModemOperationView {
	/** The band kind. `unknown-outcome` is the only path to `unknown`. */
	readonly kind: MutationOutcomeKind;
	/** One of the four result keys. */
	readonly resultKey: string;
	/** One of the five completion keys. */
	readonly completionKey: string;
	/**
	 * `true` when the completion adds information the result does not already
	 * carry. A clean `applied` says the same thing twice, so it is suppressed.
	 */
	readonly showCompletion: boolean;
	/** One of the three unknown-reason keys. `unknown-outcome` only. */
	readonly unknownReasonKey?: string;
	/** The reconciliation pointer. `unknown-outcome` only. */
	readonly reconciliationKey?: string;
	/** Whether re-issuing the SAME request could plausibly succeed. */
	readonly retrySuggested: boolean;
	/** Mirrors the wire's `requires_reconciliation`, so a caller can gate on it. */
	readonly requiresReconciliation: boolean;
}

/**
 * Whether the operator should be offered a retry.
 *
 * `unknown-outcome` is refused OUTRIGHT and first, before anything else is
 * consulted — the write may already have landed, so a retry is the one action
 * that can turn an unknown state into a wrong one. The wire pins `retryable:
 * false` on that arm too; asking twice is deliberate, because this is the rule a
 * later refactor is most likely to "simplify" into a single `outcome.retryable`
 * read.
 *
 * For everything else the PACKAGE answers, not this module: a typed daemon
 * refusal is looked up in `MODEM_MANAGER_REFUSAL_RETRYABLE` (the total record
 * `@ceralive/modem-control` authors), and a CeraUI-authored refusal — which
 * carries no typed member, by contract — rides the wire's own `retryable`, which
 * is `false` by construction because an identical CeraUI-side decision produces
 * an identical answer.
 */
export function modemOperationRetrySuggested(
	outcome: ModemOperationOutcome,
): boolean {
	if (outcome.status === "unknown-outcome") return false;
	if (outcome.status === "applied") return false;
	return outcome.refusal === undefined
		? outcome.retryable
		: MODEM_MANAGER_REFUSAL_RETRYABLE[outcome.refusal];
}

/**
 * Read one wire outcome into keys.
 *
 * `failed` and `refused` share the band's `refused` kind because the band has
 * three kinds and both mean "the operator's change is not in force" — the
 * DIFFERENCE between them (the device said no, versus the device tried and could
 * not) is carried by the result sentence, which is why that sentence always
 * renders rather than only decorating a refusal.
 */
export function modemOperationView(
	outcome: ModemOperationOutcome,
): ModemOperationView {
	const completionKey = MODEM_OPERATION_COMPLETION_KEY[outcome.completion];
	const resultKey = MODEM_OPERATION_RESULT_KEY[outcome.status];
	const retrySuggested = modemOperationRetrySuggested(outcome);

	if (outcome.status === "unknown-outcome") {
		return {
			kind: "unknown",
			resultKey,
			completionKey,
			showCompletion: true,
			unknownReasonKey: MODEM_OPERATION_UNKNOWN_REASON_KEY[outcome.reason],
			reconciliationKey: MODEM_OPERATION_RECONCILIATION_KEY,
			retrySuggested,
			requiresReconciliation: true,
		};
	}

	return {
		kind: outcome.status === "applied" ? "applied" : "refused",
		resultKey,
		completionKey,
		// A `refused`/`failed` result whose completion repeats the same word adds
		// nothing; every other pairing is the device's own separate fact.
		showCompletion: outcome.completion !== outcome.status,
		retrySuggested,
		requiresReconciliation: false,
	};
}

/**
 * The band's detail block, ALREADY localized (LR-4).
 *
 * Resolution happens here rather than in the component so the band never holds a
 * key or a wire token, which is what makes "a machine identifier cannot reach an
 * operator" a structural property of that component rather than a review note.
 */
export function modemOperationDetail(
	outcome: ModemOperationOutcome,
	t: TranslateLabel,
): MutationOutcomeDetail {
	const view = modemOperationView(outcome);
	return {
		result: t(view.resultKey),
		...(view.showCompletion ? { completion: t(view.completionKey) } : {}),
		...(view.unknownReasonKey === undefined
			? {}
			: { unknownReason: t(view.unknownReasonKey) }),
		...(view.reconciliationKey === undefined
			? {}
			: { reconciliation: t(view.reconciliationKey) }),
		...(view.retrySuggested ? { retry: t(MODEM_OPERATION_RETRY_KEY) } : {}),
	};
}

/** The band kind one wire outcome renders as. Never `applied` for an unknown one. */
export function modemOperationKind(
	outcome: ModemOperationOutcome,
): MutationOutcomeKind {
	return modemOperationView(outcome).kind;
}

/** Everything `MutationOutcomeBand` needs for one modem write. */
export interface ModemWriteBand {
	readonly outcome: MutationOutcome | undefined;
	readonly detail: MutationOutcomeDetail | undefined;
}

/**
 * Build a write flow's band from its own sentence plus the classified outcome.
 *
 * EVERY modem write render site goes through this, and that is the point rather
 * than a convenience: the band KIND is derived from the classification here, so
 * no call site can pick it by hand — which is the only way an `unknown-outcome`
 * ever ends up rendered as a refusal. A flow whose wire carries no classification
 * keeps `fallbackKind`, so it is byte-identical to what it rendered before.
 */
export function modemWriteBand(
	operation: ModemOperationOutcome | undefined,
	message: string,
	t: TranslateLabel,
	fallbackKind: MutationOutcomeKind = "refused",
): ModemWriteBand {
	if (operation === undefined) {
		return {
			outcome: mutationOutcome(fallbackKind, message),
			detail: undefined,
		};
	}
	return {
		outcome: mutationOutcome(modemOperationKind(operation), message),
		detail: modemOperationDetail(operation, t),
	};
}
