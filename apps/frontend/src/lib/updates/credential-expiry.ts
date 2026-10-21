/**
 * The Updates dialog's "Update credentials" row.
 *
 * `system.getUpdateDetails` may carry `credentials` (`UpdateCredentials`): the
 * public expiry date of the device's update certificate, in epoch ms, and the
 * device's verdict about it. An absent block is an older backend and renders
 * nothing. The verdict is the DEVICE's, judged on its own clock; this module
 * only decides what the row may truthfully say about it:
 *
 * - a `valid` verdict without a usable date reads as unknown, because "valid"
 *   is never shown without the evidence behind it;
 * - an `expiring` or `expired` verdict without a date is kept, because a
 *   problem the device reports is never hidden;
 * - the "in about N days" phrase is computed from this browser's clock, only
 *   for an `expiring` credential whose expiry is still ahead on that clock. It
 *   is the floor of whole days left, so it never runs negative: a clock that
 *   has already passed the date shows no phrase rather than "in -3 days".
 *
 * Pure and dependency-free (Intl only); resolve the returned keys at the render
 * site with `resolveMessageKey`, as `update-view.ts` does.
 */
import type { UpdateCredentials } from "@ceraui/rpc/schemas";

export const DAY_MS = 86_400_000;

export type CredentialExpiryState = UpdateCredentials["state"];

/** The `Badge` status variant each state renders with; the label carries the meaning. */
export type CredentialExpiryTone = "success" | "warning" | "error" | "neutral";

const STATE_TONE: Readonly<
	Record<CredentialExpiryState, CredentialExpiryTone>
> = {
	valid: "success",
	expiring: "warning",
	expired: "error",
	unavailable: "neutral",
};

export const CREDENTIAL_EXPIRY_TITLE_KEY =
	"settings.updates.credentials.expiry.title";

export const CREDENTIAL_EXPIRY_STATE_KEYS: Readonly<
	Record<CredentialExpiryState, string>
> = {
	valid: "settings.updates.credentials.expiry.valid",
	expiring: "settings.updates.credentials.expiry.expiring",
	expired: "settings.updates.credentials.expiry.expired",
	unavailable: "settings.updates.credentials.expiry.unavailable",
};

export const CREDENTIAL_EXPIRY_COPY_KEYS = {
	expiresOn: "settings.updates.credentials.expiry.expiresOn",
	expiredOn: "settings.updates.credentials.expiry.expiredOn",
	inAbout: "settings.updates.credentials.expiry.inAbout",
	lessThanDay: "settings.updates.credentials.expiry.lessThanDay",
	unreadable: "settings.updates.credentials.expiry.unreadable",
} as const;

export interface CredentialExpiryView {
	/** The state the row shows (see the module comment for when it differs from the wire). */
	readonly state: CredentialExpiryState;
	readonly tone: CredentialExpiryTone;
	readonly stateKey: string;
	/** The certificate's expiry in epoch ms; `undefined` when no usable date was reported. */
	readonly expiresAt: number | undefined;
	/** `expiresOn`/`expiredOn` when a date is shown, `unreadable` otherwise. */
	readonly detailKey: string;
	/** Whole days left on this clock; only for `expiring` with the expiry still ahead. */
	readonly daysLeft: number | undefined;
	/**
	 * Milliseconds after the view's `now` until `daysLeft` changes, taken from
	 * the same `now` so a recount timer never lags the count it refreshes;
	 * `undefined` whenever `daysLeft` is.
	 */
	readonly recountInMs: number | undefined;
}

/** The ECMAScript time-value range; a number outside it is not a date. */
const MAX_TIME_VALUE_MS = 8.64e15;

function usableDate(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		Math.abs(value) <= MAX_TIME_VALUE_MS
		? value
		: undefined;
}

/**
 * Whole days left before `expiresAt` on the clock `now` (floor), or `undefined`
 * once nothing is left. `0` means less than one whole day remains.
 */
export function wholeDaysLeft(
	expiresAt: number,
	now: number,
): number | undefined {
	if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return undefined;
	const remaining = expiresAt - now;
	if (remaining <= 0) return undefined;
	return Math.floor(remaining / DAY_MS);
}

/**
 * Milliseconds until `wholeDaysLeft(expiresAt, now)` next changes: the next
 * whole-day boundary, or the expiry itself on the last day. `undefined` once
 * nothing is left. Lets an open row advance its count with one timer per day.
 */
export function msUntilDaysLeftChanges(
	expiresAt: number,
	now: number,
): number | undefined {
	if (wholeDaysLeft(expiresAt, now) === undefined) return undefined;
	const remaining = expiresAt - now;
	return Math.min(remaining, (remaining % DAY_MS) + 1);
}

function knownState(state: unknown): CredentialExpiryState | undefined {
	return typeof state === "string" && Object.hasOwn(STATE_TONE, state)
		? (state as CredentialExpiryState)
		: undefined;
}

/**
 * What the row shows for the device's `credentials` block at time `now`, or
 * `undefined` when the block is absent (an older backend: render nothing).
 */
export function credentialExpiryView(
	credentials: UpdateCredentials | undefined,
	now: number,
): CredentialExpiryView | undefined {
	if (credentials === undefined) return undefined;
	const expiresAt = usableDate(credentials.expiresAt);
	const reported = knownState(credentials.state);
	// An unrecognised verdict, an `unavailable` one, and a `valid` claim with no
	// date behind it all read as unknown; a reported problem is always kept.
	const state: CredentialExpiryState =
		reported === undefined ||
		reported === "unavailable" ||
		(reported === "valid" && expiresAt === undefined)
			? "unavailable"
			: reported;
	const shownDate = state === "unavailable" ? undefined : expiresAt;
	const daysLeft =
		state === "expiring" && shownDate !== undefined
			? wholeDaysLeft(shownDate, now)
			: undefined;
	return {
		state,
		tone: STATE_TONE[state],
		stateKey: CREDENTIAL_EXPIRY_STATE_KEYS[state],
		expiresAt: shownDate,
		detailKey:
			shownDate === undefined
				? CREDENTIAL_EXPIRY_COPY_KEYS.unreadable
				: state === "expired"
					? CREDENTIAL_EXPIRY_COPY_KEYS.expiredOn
					: CREDENTIAL_EXPIRY_COPY_KEYS.expiresOn,
		daysLeft,
		recountInMs:
			daysLeft === undefined || shownDate === undefined
				? undefined
				: msUntilDaysLeftChanges(shownDate, now),
	};
}

/**
 * A whole-day count as the locale's own plural noun phrase ("1 day",
 * "12 days", "يومان"). `Intl` owns the plural rules, so the catalog phrase that
 * embeds it needs no plural variants.
 */
export function formatDayCount(days: number, locale: string): string {
	return new Intl.NumberFormat(locale, {
		style: "unit",
		unit: "day",
		unitDisplay: "long",
	}).format(days);
}

export interface CredentialRemainingCopy {
	readonly key: string;
	readonly params?: Readonly<Record<string, string>>;
}

/** The "in about N days" phrase for `daysLeft`, or `undefined` when there is none. */
export function credentialRemainingCopy(
	daysLeft: number | undefined,
	locale: string,
): CredentialRemainingCopy | undefined {
	if (daysLeft === undefined || !Number.isInteger(daysLeft) || daysLeft < 0)
		return undefined;
	if (daysLeft === 0) return { key: CREDENTIAL_EXPIRY_COPY_KEYS.lessThanDay };
	return {
		key: CREDENTIAL_EXPIRY_COPY_KEYS.inAbout,
		params: { duration: formatDayCount(daysLeft, locale) },
	};
}
