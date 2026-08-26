/**
 * THE OPERATOR-LABEL GATE: a raw wire token never reaches an operator label.
 *
 * `DESIGN.md` §3 (OL-1/OL-2/OL-5) is the rule; this is the mechanism. Two things
 * about its shape are deliberate and should not be "simplified":
 *
 * 1. IT DRIVES THE REAL TEN-LOCALE CATALOG, not a fake `t`. A stub translator
 *    would only prove that the formatter picked a key — it would say nothing
 *    about the copy behind that key, and the copy is where a token actually
 *    leaks (`"Switch to rndis"` was a message value, not a code path). Running
 *    every locale also catches the case where nine catalogs are clean and one
 *    translator pasted the token in.
 * 2. THE ASSERTION IS SUBSTRING-ABSENCE OVER THE RENDERED STRING, and it is
 *    checked case-insensitively, because the leak this replaces was
 *    `{usbModeLabel(mode)}` returning `mode` verbatim — a form no key-shape
 *    assertion could ever see.
 *
 * `network.modem.bands.label.frequency` is the one intentional exception to the
 * "must not equal the English value" instinct: it is `{generation} {frequency}`
 * in every locale because it composes two values and contains no words.
 */

import { LOCALES, type LocaleCode } from "@ceraui/i18n";
import { setLocale } from "@ceraui/i18n/svelte";
import {
	MODEM_MANAGER_REFUSAL_RETRYABLE,
	type ModemManagerRefusalReason,
	type ModemOperationCompletionStatus,
	type ModemOperationOutcome,
	type ModemOperationResultStatus,
	type ModemOperationUnknownReason,
	type UsbCompositionMode,
	usbCompositionModeSchema,
} from "@ceraui/rpc/schemas";
import { beforeAll, describe, expect, it } from "vitest";

import {
	bandListOperatorLabel,
	bandOperatorLabel,
	isMachineIdentifier,
	isMappedBandToken,
	MODEM_OPERATION_COMPLETION_KEY,
	MODEM_OPERATION_RECONCILIATION_KEY,
	MODEM_OPERATION_RESULT_KEY,
	MODEM_OPERATION_RETRY_KEY,
	MODEM_OPERATION_UNKNOWN_REASON_KEY,
	modemOperationDetail,
	modemOperationRetrySuggested,
	modemOperationView,
	modemWriteBand,
	parseBandToken,
	USB_MODE_LABEL_KEY,
	USB_MODE_RAW_TOKENS,
	usbModeOperatorLabel,
} from "./operator-labels";
import { refusalCopyKey } from "./refusal-taxonomy";

const LOCALE_CODES: readonly LocaleCode[] = LOCALES.map((entry) => entry.code);

/** The live catalog lookup, bound per locale inside each assertion. */
let translate: (key: string, params?: Record<string, string>) => string;

beforeAll(async () => {
	const svelte = await import("@ceraui/i18n/svelte");
	translate = svelte.resolveMessageKey;
});

function withLocale<T>(locale: LocaleCode, run: () => T): T {
	setLocale(locale, { reload: false });
	try {
		return run();
	} finally {
		setLocale("en", { reload: false });
	}
}

/**
 * The token shapes DESIGN.md OL-1 bans outright, plus the two spellings the
 * `ecm-ncm` value decomposes into — a label reading "ECM mode" would satisfy a
 * naive whole-token scan while leaking exactly what OL-1 names.
 */
const BANNED_USB_FRAGMENTS = [
	"qmi",
	"mbim",
	"ecm",
	"ncm",
	"rndis",
	"hilink",
	"ppp",
	"router-ethernet",
] as const;

/**
 * Bands that must never appear verbatim in a label, one per grammar family.
 *
 * `any` is deliberately NOT here: it is the RESET value, not a band, and its
 * copy ("Any band") legitimately contains the word — asserting substring
 * absence on it would be asserting against English rather than against a leak.
 * It gets its own equality assertion below instead.
 */
const BAND_TOKENS = [
	"eutran-3",
	"eutran-20",
	"ngran-78",
	"utran-1",
	"geran-8",
	"b20",
	"n78",
	"nr-n41",
	"lte-b7",
	"egsm",
	"dcs",
	"pcs",
	"g850",
	"xyzzy-9",
	"cdma-bc0",
] as const;

describe("usbModeOperatorLabel — OL-1: no raw USB-mode token in operator copy", () => {
	it("Given the wire enum, When the label table is read, Then every value has a key", () => {
		expect(Object.keys(USB_MODE_LABEL_KEY).sort()).toEqual(
			[...usbCompositionModeSchema.options].sort(),
		);
		expect([...USB_MODE_RAW_TOKENS].sort()).toEqual(
			[...usbCompositionModeSchema.options].sort(),
		);
	});

	for (const locale of LOCALE_CODES) {
		it.each([...USB_MODE_RAW_TOKENS])(
			`Given ${locale} and the %s composition, When labelled, Then the token is absent`,
			(mode: UsbCompositionMode) => {
				const label = withLocale(locale, () =>
					usbModeOperatorLabel(mode, translate),
				);
				expect(label.length).toBeGreaterThan(0);
				// A dotted key reaching the operator is the OTHER failure mode of a
				// keyed-copy scheme, and it looks nothing like a raw token.
				expect(label).not.toContain("network.modem.");
				for (const fragment of BANNED_USB_FRAGMENTS) {
					expect(label.toLowerCase()).not.toContain(fragment);
				}
			},
		);
	}

	it("Given no reported composition, When labelled, Then it reads as unknown rather than empty", () => {
		const label = usbModeOperatorLabel(undefined, translate);
		expect(label.length).toBeGreaterThan(0);
		expect(label).not.toContain("network.modem.");
	});

	// NON-VACUITY: the assertion above must be able to fail. Feeding it the raw
	// token proves the detector fires rather than passing on everything.
	it("Given the retired raw-token label, When scanned, Then the detector fires", () => {
		const leaked = "rndis";
		const fired = BANNED_USB_FRAGMENTS.some((fragment) =>
			leaked.toLowerCase().includes(fragment),
		);
		expect(fired).toBe(true);
	});
});

describe("bandOperatorLabel — OL-2/OL-5: no raw band token in operator copy", () => {
	for (const locale of LOCALE_CODES) {
		it.each([...BAND_TOKENS])(
			`Given ${locale} and the band %s, When labelled, Then the token is absent`,
			(token: string) => {
				const label = withLocale(locale, () =>
					bandOperatorLabel(token, translate),
				);
				expect(label.length).toBeGreaterThan(0);
				expect(label).not.toContain("network.modem.");
				expect(label.toLowerCase()).not.toContain(token.toLowerCase());
			},
		);
	}

	it("Given the reset value, When labelled, Then it reuses the existing proven copy", () => {
		for (const locale of LOCALE_CODES) {
			const label = withLocale(locale, () =>
				bandOperatorLabel("any", translate),
			);
			expect(label).toBe(
				withLocale(locale, () => translate("network.modem.bands.any")),
			);
			expect(label).not.toContain("network.modem.");
		}
	});

	it("Given every grammar family, When parsed, Then the generation and number are read out", () => {
		expect(parseBandToken("eutran-3")).toEqual({
			kind: "numbered",
			generation: "lte",
			band: "3",
		});
		expect(parseBandToken("NGRAN-78")).toEqual({
			kind: "numbered",
			generation: "nr",
			band: "78",
		});
		expect(parseBandToken("utran-1")).toEqual({
			kind: "numbered",
			generation: "umts",
			band: "1",
		});
		expect(parseBandToken("n78")).toEqual({
			kind: "numbered",
			generation: "nr",
			band: "78",
		});
		expect(parseBandToken("b20")).toEqual({
			kind: "numbered",
			generation: "lte",
			band: "20",
		});
		expect(parseBandToken("dcs")).toEqual({
			kind: "frequency",
			generation: "gsm",
			frequency: "1800 MHz",
		});
		expect(parseBandToken("any")).toEqual({ kind: "any" });
	});

	// `ngran-78` and `n78` both start with `n`, so a bare `n<number>` rule placed
	// first would read "gran-78" as nothing and fall through — or worse, match a
	// different number out of the same token.
	it("Given the explicit and the bare 5G spellings, When parsed, Then both read band 78", () => {
		expect(parseBandToken("ngran-78")).toEqual(parseBandToken("n78"));
	});

	it("Given a token this build cannot name, When labelled, Then it is generic and never the token", () => {
		expect(isMappedBandToken("xyzzy-9")).toBe(false);
		expect(isMappedBandToken("cdma-bc0")).toBe(false);
		const label = bandOperatorLabel("xyzzy-9", translate);
		expect(label).toBe(translate("network.modem.bands.label.unmapped"));
	});

	// A band NUMBER of zero exists in no 3GPP table, so parsing one means the
	// grammar matched something it did not actually understand.
	it("Given a zero band number, When parsed, Then it is unmapped rather than band 0", () => {
		expect(parseBandToken("eutran-0").kind).toBe("unmapped");
		expect(parseBandToken("b0").kind).toBe("unmapped");
	});

	it("Given a locked set, When listed, Then every element is a label and none is a token", () => {
		const line = bandListOperatorLabel(["eutran-3", "ngran-78"], translate);
		expect(line).toBeDefined();
		expect(line).not.toContain("eutran");
		expect(line).not.toContain("ngran");
		expect(line).toContain(",");
	});

	// An empty set must not produce a dangling "Currently locked to ." sentence.
	it("Given an empty set, When listed, Then it answers undefined rather than an empty string", () => {
		expect(bandListOperatorLabel([], translate)).toBeUndefined();
	});
});

/*
  THE OPERATION VOCABULARY — 12 values, and the two rules that make it worth
  carrying at all.

  Everything below drives the REAL ten-locale catalog, for the reason the header
  gives: the leak this whole module exists to stop lives in the copy, not in the
  key choice.
*/
describe("modem operation vocabulary", () => {
	const COMPLETIONS: readonly ModemOperationCompletionStatus[] = [
		"applied",
		"refused",
		"failed",
		"timed-out",
		"dropped",
	];
	const RESULTS: readonly ModemOperationResultStatus[] = [
		"applied",
		"refused",
		"unknown-outcome",
		"failed",
	];
	const UNKNOWN_REASONS: readonly ModemOperationUnknownReason[] = [
		"stale-generation",
		"write-reply-timed-out",
		"write-reply-dropped",
	];

	function unknownOutcome(
		reason: ModemOperationUnknownReason,
		completion: ModemOperationCompletionStatus = "timed-out",
	): ModemOperationOutcome {
		return {
			status: "unknown-outcome",
			completion,
			reason,
			requires_reconciliation: true,
			retryable: false,
		};
	}

	function refusal(
		reason: ModemManagerRefusalReason,
		completion: ModemOperationCompletionStatus = "failed",
	): ModemOperationOutcome {
		return {
			status: "refused",
			completion,
			reason,
			refusal: reason,
			retryable: MODEM_MANAGER_REFUSAL_RETRYABLE[reason],
		};
	}

	// 5 + 4 + 3 = 12. Counted as three enums rather than eleven distinct strings
	// because `applied`/`refused`/`failed` mean different things on each side.
	it("Given the three enums, When counted, Then they carry exactly 12 values", () => {
		expect(COMPLETIONS).toHaveLength(5);
		expect(RESULTS).toHaveLength(4);
		expect(UNKNOWN_REASONS).toHaveLength(3);
		expect(Object.keys(MODEM_OPERATION_COMPLETION_KEY)).toHaveLength(5);
		expect(Object.keys(MODEM_OPERATION_RESULT_KEY)).toHaveLength(4);
		expect(Object.keys(MODEM_OPERATION_UNKNOWN_REASON_KEY)).toHaveLength(3);
	});

	it.each(LOCALE_CODES)(
		"Given every one of the 12 values in %s, When rendered, Then each has copy and none is a wire token",
		(locale) => {
			withLocale(locale, () => {
				const keys = [
					...COMPLETIONS.map((c) => MODEM_OPERATION_COMPLETION_KEY[c]),
					...RESULTS.map((r) => MODEM_OPERATION_RESULT_KEY[r]),
					...UNKNOWN_REASONS.map((r) => MODEM_OPERATION_UNKNOWN_REASON_KEY[r]),
					MODEM_OPERATION_RETRY_KEY,
					MODEM_OPERATION_RECONCILIATION_KEY,
				];
				for (const key of keys) {
					const sentence = translate(key);
					expect(sentence.length).toBeGreaterThan(0);
					expect(sentence).not.toContain(key);
					// The wire spellings are machine identifiers by this module's own
					// test, so a leak is exactly a hyphenated lowercase token on screen.
					for (const token of [
						...COMPLETIONS,
						...RESULTS,
						...UNKNOWN_REASONS,
					]) {
						if (!isMachineIdentifier(token)) continue;
						expect(sentence.toLowerCase()).not.toContain(token);
					}
				}
			});
		},
	);

	// The whole surface renders three DIFFERENT sentences per value class; two
	// values sharing one is the collapse this vocabulary replaced.
	it.each(LOCALE_CODES)(
		"Given the 12 values in %s, When rendered, Then no two share a sentence",
		(locale) => {
			withLocale(locale, () => {
				const sentences = [
					...COMPLETIONS.map((c) =>
						translate(MODEM_OPERATION_COMPLETION_KEY[c]),
					),
					...RESULTS.map((r) => translate(MODEM_OPERATION_RESULT_KEY[r])),
					...UNKNOWN_REASONS.map((r) =>
						translate(MODEM_OPERATION_UNKNOWN_REASON_KEY[r]),
					),
				];
				expect(new Set(sentences).size).toBe(sentences.length);
			});
		},
	);

	// The reconciliation pointer must BE the mutation-block sentence, not a
	// look-alike: a second wording is the parallel "unknown state" surface this
	// change exists to avoid building.
	it("Given the reconciliation pointer, When resolved, Then it is the existing mutation-block copy", () => {
		expect(MODEM_OPERATION_RECONCILIATION_KEY).toBe(
			refusalCopyKey("reconciliation-required"),
		);
	});

	it.each(UNKNOWN_REASONS)(
		"Given unknown-outcome %s, When viewed, Then it is neither applied nor refused and routes to reconciliation",
		(reason) => {
			const view = modemOperationView(unknownOutcome(reason));
			expect(view.kind).toBe("unknown");
			expect(view.kind).not.toBe("applied");
			expect(view.kind).not.toBe("refused");
			expect(view.requiresReconciliation).toBe(true);
			expect(view.reconciliationKey).toBe(MODEM_OPERATION_RECONCILIATION_KEY);
			expect(view.unknownReasonKey).toBe(
				MODEM_OPERATION_UNKNOWN_REASON_KEY[reason],
			);
			expect(view.retrySuggested).toBe(false);
		},
	);

	// Every completion the classifier can pair with `unknown-outcome` must still
	// reach the reconciliation band — the kind follows the RESULT, never the
	// completion, or a `dropped` write would render as a plain failure.
	it.each(COMPLETIONS)(
		"Given an unknown outcome whose completion is %s, When viewed, Then it still routes to reconciliation",
		(completion) => {
			const view = modemOperationView(
				unknownOutcome("write-reply-dropped", completion),
			);
			expect(view.kind).toBe("unknown");
			expect(view.completionKey).toBe(
				MODEM_OPERATION_COMPLETION_KEY[completion],
			);
		},
	);

	/*
	  THE LOAD-BEARING SPLIT. `timed-out` is ONE completion with TWO meanings —
	  `unknown-outcome` on a write, plain `failed` on a read — so the pair must
	  render in two visibly different bands. Collapsing them is the single most
	  likely "simplification" of this module.
	*/
	it("Given the SAME `timed-out` completion, When it is a write and a read, Then the two render differently", () => {
		const write = modemOperationView(
			unknownOutcome("write-reply-timed-out", "timed-out"),
		);
		const read = modemOperationView({
			status: "failed",
			completion: "timed-out",
			reason: "timed out",
			refusal: "timed-out",
			retryable: MODEM_MANAGER_REFUSAL_RETRYABLE["timed-out"],
		});

		expect(write.completionKey).toBe(read.completionKey);
		expect(write.kind).toBe("unknown");
		expect(read.kind).toBe("refused");
		expect(write.resultKey).not.toBe(read.resultKey);
		expect(write.reconciliationKey).toBeDefined();
		expect(read.reconciliationKey).toBeUndefined();
		// The read arm is a daemon `timed-out` refusal, which IS retryable; the
		// write arm is not, however the same word appears in both.
		expect(read.retrySuggested).toBe(true);
		expect(write.retrySuggested).toBe(false);
	});

	it.each(
		Object.keys(MODEM_MANAGER_REFUSAL_RETRYABLE) as ModemManagerRefusalReason[],
	)(
		"Given the typed refusal %s, When viewed, Then the retry hint follows the package's own table",
		(reason) => {
			const view = modemOperationView(refusal(reason));
			expect(view.retrySuggested).toBe(MODEM_MANAGER_REFUSAL_RETRYABLE[reason]);
		},
	);

	// The four the package marks retryable, spelled out — so a table edit that
	// widened the set would redden here rather than silently invite retries.
	it("Given the eight refusals, When gated, Then exactly four suggest a retry", () => {
		const retryable = (
			Object.keys(
				MODEM_MANAGER_REFUSAL_RETRYABLE,
			) as ModemManagerRefusalReason[]
		).filter((reason) => modemOperationRetrySuggested(refusal(reason)));
		expect(retryable.sort()).toEqual(
			["busy", "disconnected", "timed-out", "wrong-state"].sort(),
		);
	});

	/*
	  THE TABLE IS THE AUTHORITY FOR A TYPED REFUSAL, and this is the only test
	  that can show it: every honest fixture has the wire field agreeing with
	  `MODEM_MANAGER_REFUSAL_RETRYABLE`, so a gate that simply read
	  `outcome.retryable` would pass all of them. Here the two DISAGREE.
	*/
	it("Given a typed refusal whose wire flag contradicts the package table, When gated, Then the table wins", () => {
		expect(
			modemOperationRetrySuggested({
				status: "refused",
				completion: "failed",
				reason: "AccessDenied",
				refusal: "unauthorized",
				retryable: true,
			}),
		).toBe(false);
		expect(
			modemOperationRetrySuggested({
				status: "failed",
				completion: "failed",
				reason: "InProgress",
				refusal: "busy",
				retryable: false,
			}),
		).toBe(true);
	});

	// The wire pins `retryable: false` on this arm, so the guard can only be shown
	// to exist by contradicting it: a retry here is the one action that can turn
	// an unknown state into a wrong one.
	it("Given an unknown outcome that claims to be retryable, When gated, Then no retry is suggested", () => {
		expect(
			modemOperationRetrySuggested({
				status: "unknown-outcome",
				completion: "dropped",
				reason: "write-reply-dropped",
				requires_reconciliation: true,
				retryable: true,
			} as unknown as ModemOperationOutcome),
		).toBe(false);
	});

	// A CeraUI-authored refusal carries no typed member by contract, so the wire's
	// own `retryable` is the only answer available — and it is `false`.
	it("Given a CeraUI-authored refusal, When gated, Then it never suggests a retry", () => {
		const view = modemOperationView({
			status: "refused",
			completion: "refused",
			reason: "provisioning_disabled",
			retryable: false,
		});
		expect(view.retrySuggested).toBe(false);
		expect(view.showCompletion).toBe(false);
	});

	it("Given a clean success, When viewed, Then it says so once and offers no retry", () => {
		const view = modemOperationView({
			status: "applied",
			completion: "applied",
			retryable: false,
		});
		expect(view.kind).toBe("applied");
		expect(view.showCompletion).toBe(false);
		expect(view.retrySuggested).toBe(false);
		expect(view.requiresReconciliation).toBe(false);
	});

	it("Given an unknown outcome, When detailed, Then it carries a reconciliation pointer and NO retry", () => {
		const detail = modemOperationDetail(
			unknownOutcome("write-reply-timed-out"),
			translate,
		);
		expect(detail.reconciliation).toBe(
			translate(MODEM_OPERATION_RECONCILIATION_KEY),
		);
		expect(detail.retry).toBeUndefined();
		expect(detail.unknownReason).toBe(
			translate(MODEM_OPERATION_UNKNOWN_REASON_KEY["write-reply-timed-out"]),
		);
		expect(detail.result).toBe(
			translate(MODEM_OPERATION_RESULT_KEY["unknown-outcome"]),
		);
	});

	it("Given a retryable refusal, When detailed, Then it carries a retry hint and NO reconciliation pointer", () => {
		const detail = modemOperationDetail(refusal("busy"), translate);
		expect(detail.retry).toBe(translate(MODEM_OPERATION_RETRY_KEY));
		expect(detail.reconciliation).toBeUndefined();
	});

	// `modemWriteBand` is the seam every render site goes through, and this is why
	// it exists: no call site picks the kind, so none of them can get this wrong.
	it("Given a write flow, When banded, Then the KIND comes from the classification, not the call site", () => {
		const unknown = modemWriteBand(
			unknownOutcome("stale-generation"),
			"the modem refused",
			translate,
		);
		expect(unknown.outcome?.kind).toBe("unknown");
		expect(unknown.detail?.reconciliation).toBeDefined();

		const applied = modemWriteBand(
			{ status: "applied", completion: "applied", retryable: false },
			"whatever the site said",
			translate,
		);
		expect(applied.outcome?.kind).toBe("applied");
	});

	// A flow whose wire carries no classification must render exactly as before.
	it("Given no classified outcome, When banded, Then the flow keeps its own kind and gains no detail", () => {
		const band = modemWriteBand(undefined, "the modem refused", translate);
		expect(band.outcome?.kind).toBe("refused");
		expect(band.outcome?.message).toBe("the modem refused");
		expect(band.detail).toBeUndefined();
	});
});
