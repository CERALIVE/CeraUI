/**
 * Audio capability selectors — pure, browser-safe derivations from the
 * capabilities contract.
 */

import type { CapabilitiesMessage } from '../schemas/streaming.schema';

/**
 * Determine whether the device supports live audio switching.
 *
 * Returns `true` only when the engine explicitly advertises the capability
 * (`audio_live_switch === true`). Absent or `false` values both return `false`,
 * ensuring safe back-compat with legacy snapshots.
 *
 * This is the sole gate for all live-audio UI (G2 constraint) — no version
 * string checks anywhere.
 */
export function isAudioLiveSwitchEnabled(caps: CapabilitiesMessage | undefined): boolean {
	return caps?.audio_live_switch === true;
}
