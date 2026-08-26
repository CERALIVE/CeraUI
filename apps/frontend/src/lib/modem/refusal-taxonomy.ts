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
 * ONE REFUSAL TAXONOMY FOR THE MODEM MUTATION SURFACE — pure and rune-free.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS REPLACES
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Every mutating modem surface resolved its own refusal copy, and every one of
 * them had an escape hatch that turned an UNKNOWN refusal into something the
 * operator could not act on:
 *
 *   · `ModemConfigDialog` built its key by INTERPOLATION
 *     (`network.modem.saveRefused.${token}`), so a token the catalog had never
 *     heard of rendered as its own dotted path on screen.
 *   · The USB-mode card did the same, twice, across TWO namespaces
 *     (`usbMode.error.*` for a refusal, `usbMode.reason.*` for the typed reason
 *     riding `transition_failed`).
 *   · `lockErrorKey` interpolated `lock.error.<token>`.
 *   · `RouterDongleDialog`'s `refusalMessage` had a literal `default` arm that
 *     answered "this dongle has no such setting" to anything it did not know —
 *     a confident, wrong sentence rather than a missing one.
 *
 * Each of those is the same bug wearing a different coat: a NEW member of a wire
 * enum ships and the operator gets a raw token, a generic toast, or an outright
 * lie. This module makes that a TYPE ERROR instead.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO EXHAUSTIVENESS FENCES, IN OPPOSITE DIRECTIONS
 * ────────────────────────────────────────────────────────────────────────────
 *
 * 1. **A NEW WIRE TOKEN fails the build.** {@link REFUSAL_CLASS_OF} is
 *    `satisfies Record<ModemRefusalToken, RefusalClass>`, where the token union
 *    is the union of every mutation-surface refusal enum `@ceraui/rpc/schemas`
 *    exports. Adding a member to any of those enums removes a required key from
 *    the record and `tsc` refuses it.
 * 2. **A NEW CLASS fails the build.** {@link refusalCopyKey} is a `switch` with
 *    NO `default` arm and a non-optional `string` return, so a class nobody
 *    keyed is a "not all code paths return a value" error. The absence of the
 *    `default` is the whole mechanism — a default would make an unkeyed class
 *    compile and render a generic sentence, which is exactly what this replaces.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A CLASS LAYER RATHER THAN token → key
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The same fact reaches the operator through several enums: `identity_unresolved`
 * is a member of FOUR of them, `streaming_active` of three. Before this module
 * those were translated independently per surface — and the catalog proves the
 * duplication was already byte-identical in places
 * (`saveRefused.identity_unresolved` and `fccUnlock.error.identity_unresolved`
 * were the same English sentence). A class is "what the operator does next", so
 * two tokens share a class exactly when they share a remedy, and one sentence
 * then cannot drift into two.
 *
 * The converse rule is the one that keeps the taxonomy honest, and it is why
 * there are twenty-one classes rather than a tidy handful: **two tokens that
 * point the operator somewhere different NEVER share a class.** `auth-failed`
 * (retype the password) and `unsupported-profile` (this build cannot perform
 * that login at all, so use the vendor's own page) are the canonical pair — they
 * are indistinguishable at the call site and call for opposite actions, so they
 * stay apart by construction. `credential-not-required` and
 * `no-credential-stored` are the same argument one step quieter.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS IN SCOPE, AND WHAT DELIBERATELY IS NOT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * In scope: the five vocabularies the modem-config surface actually answers with
 * — the shared mutation-safety enum, the config-write enum, the dongle-credential
 * enum, the operator-scan enum, and the typed ModemManager operation refusal enum.
 * Those are the paths that carried the interpolation/default defect, and every class
 * below is reachable through one of them, which is what makes the per-class rendered
 * gate possible at all.
 *
 * Out of scope, on purpose: the USB-composition switch, USSD, SMS, GPS, band-lock
 * and FCC each own a refusal vocabulary whose required key set is ALREADY derived
 * from its wire enum by a copy-completeness gate of its own, so none of them can
 * ship a token with no copy. Each also carries a surface-specific sentence a
 * shared class would blunt — the USB card composes a head plus a typed reason
 * from two namespaces, and USSD's `lte-only-unsupported` is a CARRIER policy with
 * its own band rather than a device limit. Folding them in would trade a proven
 * distinction for a smaller table. Bluetooth is a different domain entirely.
 *
 * The modem-stack prohibition table (`providers/ufi-himi/prohibitions.ts`) has no
 * token here for a structural reason rather than an oversight: those operations
 * have no implementation anywhere, so nothing dispatches them and none of their
 * reasons ever crosses this wire. A router surface that has no write answers
 * `unsupported`, which is the class it belongs in.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOTHING HERE RENDERS AN INTERNAL
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This module returns i18n KEYS, never sentences and never a wire token, so a
 * caller structurally cannot pass an engine string, an `mmcli` fragment, an AT
 * response or a JSON-RPC error body through it. `operator-copy-no-internals.
 * test.ts` sweeps the catalogs those keys resolve into.
 */

import type {
	ModemConfigRefusal,
	ModemCredentialsRefusal,
	ModemManagerRefusalReason,
	ModemMutationRefusal,
	ModemScanFailure,
} from "@ceraui/rpc/schemas";

/**
 * Every refusal token the modem-config surface can answer.
 *
 * The union is spelled out as the EXPORTED enum types rather than as string
 * literals so the compiler — not a reviewer — notices when one of them grows.
 * `ModemMutationRefusal` is already contained in `ModemConfigRefusal`; it is
 * named anyway, because it is the SHARED mutation-safety vocabulary and a reader
 * should see that it is covered without resolving the containment by hand.
 */
export type ModemRefusalToken =
	| ModemMutationRefusal
	| ModemConfigRefusal
	| ModemCredentialsRefusal
	| ModemScanFailure
	| ModemManagerRefusalReason;

/**
 * The operator-facing refusal classes.
 *
 * Ordered by how an operator meets them — device capability first, then the
 * credential ladder, then the transient conditions, then the outcomes of a write
 * that actually ran. The order is presentational only; nothing depends on it.
 */
export const REFUSAL_CLASSES = [
	"unsupported",
	"blocked-by-state",
	"auth-failed",
	"unsupported-profile",
	"locked-out",
	"credential-not-required",
	"no-credential-stored",
	"device-busy",
	"admission-refused",
	"reconciliation-required",
	"identity-unresolved",
	"hardware-gone",
	"unreachable",
	"invalid-request",
	"timed-out-unknown-outcome",
	"write-failed",
	"read-failed",
	"emulated-mode",
] as const;

export type RefusalClass = (typeof REFUSAL_CLASSES)[number];

/** The i18n stem the classes without an existing home hang off. */
export const REFUSAL_COPY_PREFIX = "network.modem.refusal";

/**
 * The three credential causes REUSE the lock section's own sentences.
 *
 * Todo 22 already wrote distinguishable copy for wrong-password / unsupported-
 * login-shape / device-lockout, in ten locales, and those three tokens reach this
 * taxonomy only from the dongle credential path — so the lock's wording is not
 * merely reusable, it is the RIGHT wording. Minting a second sentence for the
 * same fact is how two surfaces come to explain one refusal differently.
 */
const LOCK_CAUSE = "network.routerCellular.lock.cause";

/**
 * The one sentence each class reads as.
 *
 * A `switch` with NO `default`, deliberately. TypeScript's exhaustiveness check
 * on the declared `string` return is the fence: add a member to
 * {@link REFUSAL_CLASSES} and this stops compiling until it is keyed. A
 * `default` arm — or a record lookup with a `??` fallback — would silently give
 * that member the generic sentence this whole module exists to abolish.
 */
export function refusalCopyKey(refusalClass: RefusalClass): string {
	switch (refusalClass) {
		case "unsupported":
			return `${REFUSAL_COPY_PREFIX}.unsupported`;
		case "blocked-by-state":
			return `${REFUSAL_COPY_PREFIX}.blockedByState`;
		case "auth-failed":
			return `${LOCK_CAUSE}.authFailed`;
		case "unsupported-profile":
			return `${LOCK_CAUSE}.unsupportedProfile`;
		case "locked-out":
			return `${LOCK_CAUSE}.lockedOut`;
		case "credential-not-required":
			return `${REFUSAL_COPY_PREFIX}.credentialNotRequired`;
		case "no-credential-stored":
			return `${REFUSAL_COPY_PREFIX}.noCredentialStored`;
		case "device-busy":
			return `${REFUSAL_COPY_PREFIX}.deviceBusy`;
		case "admission-refused":
			return `${REFUSAL_COPY_PREFIX}.admissionRefused`;
		case "reconciliation-required":
			return `${REFUSAL_COPY_PREFIX}.reconciliationRequired`;
		case "identity-unresolved":
			return `${REFUSAL_COPY_PREFIX}.identityUnresolved`;
		case "hardware-gone":
			return `${REFUSAL_COPY_PREFIX}.hardwareGone`;
		case "unreachable":
			return `${REFUSAL_COPY_PREFIX}.unreachable`;
		case "invalid-request":
			return `${REFUSAL_COPY_PREFIX}.invalidRequest`;
		case "timed-out-unknown-outcome":
			return `${REFUSAL_COPY_PREFIX}.timedOutUnknownOutcome`;
		case "write-failed":
			return `${REFUSAL_COPY_PREFIX}.writeFailed`;
		case "read-failed":
			return `${REFUSAL_COPY_PREFIX}.readFailed`;
		case "emulated-mode":
			return `${REFUSAL_COPY_PREFIX}.emulatedMode`;
	}
}

/**
 * Which class every wire token belongs to.
 *
 * `satisfies` rather than an annotation, so the record stays exactly this literal
 * type for callers while STILL failing the build when a wire enum grows a member
 * this table has no row for. Grouped by class, with the reasoning inline —
 * every grouping below is a claim that two tokens send the operator to the same
 * place, and that claim is the only thing a reviewer needs to check.
 */
export const REFUSAL_CLASS_OF = {
	// ── ModemManager operation refusals ──────────────────────────────────────
	// These values come from the operation outcome after admission, not the
	// mutation-safety gate above. Each resolves to a distinct remedy class.
	unauthorized: "auth-failed",
	unsupported: "unsupported",
	"wrong-state": "blocked-by-state",
	busy: "device-busy",
	"not-found": "hardware-gone",
	"timed-out": "timed-out-unknown-outcome",
	disconnected: "unreachable",

	// ── The device cannot do it at all ──────────────────────────────────────
	// A capability nobody can turn on, so the honest remedy is a different modem.
	unsupported_network_type: "unsupported",
	usage_policy_unsupported: "unsupported",

	// ── The device's own live state forbids it right now ────────────────────
	// A modem still bringing its mobile profile up has not refused anything
	// durable; the remedy is to let it finish.
	unconfigured_modem: "blocked-by-state",

	// ── The credential ladder — three causes, three remedies, never merged ──
	auth_failed: "auth-failed",
	unsupported_profile: "unsupported-profile",
	locked_out: "locked-out",
	device_open: "credential-not-required",
	no_credential: "no-credential-stored",

	// ── Something else holds the device; wait and retry ─────────────────────
	// `recovery_pending` is journal replay still running: the remedy is "ask
	// again shortly", which is what the other three here say too.
	device_busy: "device-busy",
	mutation_in_progress: "device-busy",
	already_scanning: "device-busy",
	recovery_pending: "device-busy",

	// ── A stream holds the admission lease; stop it first ───────────────────
	streaming_active: "admission-refused",

	// ── An earlier change is unresolved and the device is fail-closed ───────
	// All three end at the same place: the operator has to confirm what the
	// hardware is actually in before anything else may be written to it.
	mutation_blocked: "reconciliation-required",
	device_decommissioned: "reconciliation-required",
	rebaseline_required: "reconciliation-required",

	// ── We could not pin the device to a stable identity ────────────────────
	identity_unresolved: "identity-unresolved",

	// ── The device is no longer there ───────────────────────────────────────
	unknown_modem: "hardware-gone",
	unknown_device: "hardware-gone",

	// ── It is attached and it did not answer ────────────────────────────────
	unreachable: "unreachable",

	// ── The request itself could not be accepted ────────────────────────────
	// A selected operator that has since left the air is the same shape of answer
	// as an incomplete field set: change what was asked for.
	invalid_config: "invalid-request",
	unavailable_network: "invalid-request",

	// ── Dispatched, and no answer arrived inside the bound ──────────────────
	// The outcome is genuinely UNKNOWN — neither a success nor a failure — so the
	// remedy is to re-read the device before trying again, never a blind retry.
	timed_out: "timed-out-unknown-outcome",

	// ── It ran and the write did not land ───────────────────────────────────
	write_failed: "write-failed",
	usage_policy_write_failed: "write-failed",

	// ── It ran and the read did not land ────────────────────────────────────
	// Distinct from `write-failed` in the one way that matters to an operator: a
	// read that failed left the device untouched, so nothing needs undoing.
	failed: "read-failed",

	// ── Not real hardware ───────────────────────────────────────────────────
	unavailable_in_emulated_mode: "emulated-mode",
} as const satisfies Record<ModemRefusalToken, RefusalClass>;

/** The class a wire token belongs to. Total by construction — no fallback. */
export function classifyModemRefusal(token: ModemRefusalToken): RefusalClass {
	return REFUSAL_CLASS_OF[token];
}

/** The i18n dot-path a wire token resolves to. Never the token itself. */
export function modemRefusalCopyKey(token: ModemRefusalToken): string {
	return refusalCopyKey(classifyModemRefusal(token));
}
