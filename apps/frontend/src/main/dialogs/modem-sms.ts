/**
 * ModemConfigDialog's read-only SMS-inbox derivations — PURE and rune-free.
 *
 * The inbox is a DIAGNOSTIC READ and nothing else. Nothing in this module — and
 * nothing in the section it feeds — composes, sends, deletes or edits anything,
 * because the procedure behind it (`modems.getSms`) has no such verb and never
 * will: the backend locks that with a grep gate rather than with reviewer
 * memory (see `packages/rpc/src/schemas/modems.schema.ts`). The UI half of that
 * guarantee is asserted against the real DOM in `ModemConfigDialog.sms.test.ts`.
 *
 * Two decisions live here rather than in the markup:
 *
 *  - `smsWallClock` renders the CARRIER's wall clock, never the browser's. The
 *    wire carries mmcli's service-centre timestamp verbatim (`2025-08-21T17:20:16-05`)
 *    precisely so it is not re-zoned, and re-zoning it for display would undo
 *    that on the last hop: an operator reading "17:20" is reading the time the
 *    network stamped, which is the only time the device actually knows. An
 *    unrecognised shape yields `undefined` — the row then says it has no time
 *    rather than printing a raw token or guessing one.
 *  - `isWithdrawingSmsRefusal` separates the ONE refusal that is a permanent
 *    property of the device from the three that are transient. `unsupported`
 *    means this modem exposes no Messaging interface at all, so the section
 *    withdraws ENTIRELY — an inbox affordance on a modem that can never have an
 *    inbox is dead chrome, and a refresh button beside it would misrepresent
 *    what pressing it does (the `uncertified` USB precedent in `modem-detail.ts`).
 *    The other three are states the device can leave, so they render as a calm
 *    band with the refresh still offered.
 */

import type { ModemSmsRefusal } from "@ceraui/rpc/schemas";

const SMS = "network.modem.sms";

/**
 * mmcli's service-centre stamp, as the wire carries it.
 *
 * Anchored on a full `YYYY-MM-DDTHH:MM` prefix; the seconds and the UTC offset
 * are matched only so a partial stamp cannot pass. Seconds are DROPPED from the
 * rendered value — a carrier stamps to the second but an operator scanning an
 * inbox reads to the minute, and the extra pair is noise in a dense list.
 */
const SMS_WALL_CLOCK_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?/;

/**
 * `YYYY-MM-DD HH:MM` in the offset the network stamped, or `undefined` when the
 * timestamp is absent or does not match the grammar above.
 *
 * Deliberately NOT locale-formatted. A locale-ordered date would have to go
 * through `Date`, which re-zones to the viewing browser and silently moves the
 * reading; and the ISO ordering is the instrument register this dialog already
 * uses for every other figure. The value is rendered LTR-isolated so the digits
 * survive an RTL locale intact.
 */
export function smsWallClock(
	timestamp: string | undefined,
): string | undefined {
	if (timestamp === undefined) return undefined;
	const match = SMS_WALL_CLOCK_RE.exec(timestamp.trim());
	if (!match?.[1] || !match[2]) return undefined;
	return `${match[1]} ${match[2]}`;
}

/**
 * True when the device has told us this modem can NEVER produce an inbox.
 *
 * The caller's contract on `true` is to remove the whole section, not to render
 * an error inside it.
 */
export function isWithdrawingSmsRefusal(
	refusal: ModemSmsRefusal | undefined,
): boolean {
	return refusal === "unsupported";
}

/**
 * i18n dot-path for a refusal the operator can still act on.
 *
 * `unsupported` resolves to `undefined` BY DESIGN — it has no copy because it
 * is never rendered; if it ever reaches a band, the missing key is the bug
 * report. The three transient refusals each get their own sentence, because
 * "not enabled yet" and "could not read it" are different facts and collapsing
 * them into one message would cost the operator the difference.
 */
export function smsRefusalKey(
	refusal: ModemSmsRefusal | undefined,
): string | undefined {
	if (refusal === undefined || isWithdrawingSmsRefusal(refusal)) {
		return undefined;
	}
	return `${SMS}.refused.${refusal}`;
}
