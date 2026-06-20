/**
 * modem-config-echo.ts — pure echo predicate for an optimistic modem configure.
 *
 * `rpc.modems.configure` returns a bare `{ success: true }` ack the moment the
 * write is dispatched; the device applies the NetworkManager profile and streams
 * the real result back later over the `modems`/`status` broadcast as
 * `modem.config` + `modem.network_type.active`. A `connecting → connected` cycle
 * happens on ANY re-attach and must NOT confirm — only an echo whose stored
 * fields match what we sent is proof the device applied OUR config.
 *
 * Auto-APN normalisation
 * ----------------------
 * When auto-APN is on AND the board supports it, the backend blanks
 * `apn`/`username`/`password` to `""` and echoes `autoconfig: true`
 * (modem-status.ts: `setup.has_gsm_autoconfig && config.autoconfig`); a board
 * WITHOUT gsm-autoconfig forces the echo to `autoconfig: false` regardless of
 * intent and leaves the credentials as sent. So when we asked for auto-APN the
 * credentials are not user-meaningful — this predicate matches on
 * network-type/roaming/network/autoconfig-intent and deliberately does NOT gate
 * on the (blanked-or-not) credentials. Only the MANUAL path compares them.
 */

/** The config fields we dispatched (post-normalisation: roaming-off → network ""). */
export interface ModemConfigSent {
	network_type: string;
	roaming: boolean;
	network: string;
	autoconfig: boolean;
	apn: string;
	username: string;
	password: string;
}

/** The minimal slice of a broadcast `modem` this predicate reads. */
export interface ModemConfigEcho {
	networkTypeActive: string | null;
	config?: {
		apn: string;
		username: string;
		password: string;
		roaming: boolean;
		network: string;
		autoconfig?: boolean;
	};
}

/**
 * Whether a broadcast `modem` echo proves the device applied the config we sent.
 *
 * Requires the live `network_type.active` to equal the requested network type
 * and the stored `roaming`/`network` to match. Credentials are compared only on
 * the manual-APN path (auto-APN blanks them on real hardware, leaves them on a
 * board without gsm-autoconfig — neither is user-meaningful).
 */
export function modemConfigEchoMatches(
	sent: Readonly<ModemConfigSent>,
	echo: Readonly<ModemConfigEcho>,
): boolean {
	const config = echo.config;
	if (!config) return false;

	// The active network type is the strongest discriminator: a stale pre-save
	// echo still carries the OLD active type, so this gates out a premature
	// confirm on a connection-state cycle.
	if (echo.networkTypeActive !== sent.network_type) return false;
	if (config.roaming !== sent.roaming) return false;
	if (config.network !== sent.network) return false;

	// Auto-APN intent: the echo legitimately reports autoconfig on (creds blanked)
	// or off (board lacks gsm-autoconfig, creds left as sent). Either is a match —
	// the credentials are not user-meaningful, so don't gate on them.
	if (sent.autoconfig) return true;

	// Manual APN: autoconfig must be off and the credentials must echo as sent.
	if (config.autoconfig === true) return false;
	return (
		config.apn === sent.apn &&
		config.username === sent.username &&
		config.password === sent.password
	);
}
