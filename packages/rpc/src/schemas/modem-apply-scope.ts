/**
 * WHICH modem-config edits force NetworkManager to re-establish the bearer.
 *
 * Measured on a Rock 5B+ against NetworkManager 1.42.4 (2026-08-17): NM keeps a
 * per-property reapply allowlist and refuses everything outside it —
 * `Reapplying connection to device 'eth0' … failed: Can't reapply changes to
 * '802-3-ethernet.mac-address' setting`. No `gsm.*` property is on that list,
 * and a modem device answers `Device is not activated` for `nmcli device
 * reapply cdc-wdm0` while it holds no bearer. Every field below is therefore
 * consumed by ModemManager only at `Simple.Connect` time: `gsm.home-only`
 * becomes the bearer's `allow-roaming`, `gsm.auto-config` decides whether the
 * APN is looked up at all, and `gsm.apn`/`username`/`password`/`network-id` are
 * connect parameters. A live bearer cannot absorb any of them.
 *
 * So the honest rule is NOT "never reconnect" — it is "reconnect only when a
 * connect-time value ACTUALLY changed", which is the question this module
 * answers. It lives in `@ceraui/rpc` because both halves must agree: the
 * backend decides whether to tear the bearer down, and the dialog warns the
 * operator BEFORE they save. Two copies of this rule would drift, and the
 * drift would be a UI that promises no interruption while the device causes
 * one (or the reverse).
 */

/**
 * The connect-time inputs, already NORMALIZED. Comparing raw form values is
 * wrong: with automatic APN on, NetworkManager is handed empty APN credentials
 * regardless of what the operator last typed, so a stale APN string in a
 * disabled field must not read as a change.
 */
export type ModemConnectionFields = {
	readonly autoconfig: boolean;
	readonly apn: string;
	readonly username: string;
	readonly password: string;
	readonly roaming: boolean;
	readonly network: string;
};

/** Field keys in a stable order, so a diff reads the same on both halves. */
export const MODEM_CONNECTION_FIELD_KEYS = [
	'autoconfig',
	'apn',
	'username',
	'password',
	'roaming',
	'network',
] as const satisfies ReadonlyArray<keyof ModemConnectionFields>;

export type ModemConnectionFieldKey = (typeof MODEM_CONNECTION_FIELD_KEYS)[number];

/** The raw, un-normalized shape both halves happen to hold. */
export type ModemConnectionDraft = {
	readonly autoconfig?: boolean | undefined;
	readonly apn?: string | undefined;
	readonly username?: string | undefined;
	readonly password?: string | undefined;
	readonly roaming?: boolean | undefined;
	readonly network?: string | undefined;
};

/**
 * Fold a draft onto the values NetworkManager will really carry.
 *
 * Mirrors `sanitizeModemConfigForNetworkManager` exactly, and the mirroring is
 * the point:
 * - automatic APN that the device cannot honour is not automatic APN, so an
 *   unsupported board normalizes `autoconfig` to `false` (the backend's
 *   `resolveGsmAutoconfigSupport()` gate);
 * - with automatic APN ON the three APN credentials are cleared, because that
 *   is what gets written;
 * - `network` is a manual operator lock that only applies while roaming is
 *   permitted, so it is cleared with roaming off (`gsm.network-id`).
 */
export function normalizeModemConnectionFields(
	draft: ModemConnectionDraft,
	autoconfigSupported: boolean,
): ModemConnectionFields {
	const autoconfig = autoconfigSupported && draft.autoconfig === true;
	const roaming = draft.roaming === true;
	return {
		autoconfig,
		apn: autoconfig ? '' : (draft.apn ?? ''),
		username: autoconfig ? '' : (draft.username ?? ''),
		password: autoconfig ? '' : (draft.password ?? ''),
		roaming,
		network: roaming ? (draft.network ?? '') : '',
	};
}

/** Connect-time fields whose value differs, in `MODEM_CONNECTION_FIELD_KEYS` order. */
export function diffModemConnectionFields(
	previous: ModemConnectionFields,
	next: ModemConnectionFields,
): ReadonlyArray<ModemConnectionFieldKey> {
	return MODEM_CONNECTION_FIELD_KEYS.filter((key) => previous[key] !== next[key]);
}

/**
 * Whether NetworkManager currently holds the profile. Deliberately tri-state:
 * `unknown` is what an unreadable `nmcli` answer means, and it is NOT `idle`.
 */
export type ModemConnectionHold = 'held' | 'idle' | 'unknown';

export type ModemReactivationDecision =
	| { readonly reactivate: false; readonly reason: 'unchanged' | 'not-held' }
	| {
			readonly reactivate: true;
			readonly reason: 'connect-time-change';
			readonly changed: ReadonlyArray<ModemConnectionFieldKey>;
	  };

/**
 * Decide whether a save must tear the bearer down.
 *
 * Order is the contract:
 * 1. **Nothing changed ⇒ never.** This is the case the operator reported —
 *    toggling roaming or automatic APN and putting it back, or re-saving an
 *    untouched dialog, used to disconnect just as hard as a real edit.
 * 2. **NM is not holding the profile ⇒ never.** There is no bearer to
 *    interrupt, and the new values are read at the next activation anyway. A
 *    `searching` modem is the common case here, and it is exactly the one the
 *    old unconditional `nmcli conn down` shouted into (board journal:
 *    `nmDisconnect err: … is not an active connection`).
 * 3. Otherwise the change is a connect-time one on a bearer NM owns, so a
 *    reactivation is the ONLY way to apply it — say so rather than pretend.
 *
 * `unknown` is treated as HELD: assuming idle would silently skip the
 * reactivation and leave the operator's setting unapplied with no sign of it,
 * which is worse than a reconnect they were warned about.
 */
export function decideModemReactivation(input: {
	readonly previous: ModemConnectionFields;
	readonly next: ModemConnectionFields;
	readonly hold: ModemConnectionHold;
}): ModemReactivationDecision {
	const changed = diffModemConnectionFields(input.previous, input.next);
	if (changed.length === 0) return { reactivate: false, reason: 'unchanged' };
	if (input.hold === 'idle') return { reactivate: false, reason: 'not-held' };
	return { reactivate: true, reason: 'connect-time-change', changed };
}
