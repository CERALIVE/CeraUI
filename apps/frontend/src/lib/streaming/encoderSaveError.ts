/**
 * Operator copy for a REFUSED encoder save (device-quality-wave3 todo 11a).
 *
 * `streaming.setConfig` resolves with `{success:false, error}` rather than
 * throwing, so a caller that only wraps the await in try/catch reports a refusal
 * as "Saved" — the exact dishonesty this effort exists to end. Every save path
 * (LiveView and the federated encoder bundle) routes its verdict through here.
 *
 * `device_mode_unsupported` gets copy naming the actual cause and the action that
 * fixes it. It should be UNREACHABLE from the dialog — the same shared rule
 * (`@ceraui/rpc` `capabilities/device-mode-truth`) already blocks the save inline
 * and disables the rung with a reason. It stays reachable by a direct RPC call,
 * and by a genuine race: the device's ladder can shrink between the render and
 * the save. The backend is the guarantee; this is how that guarantee reads.
 *
 * Anything else falls back to the generic failure copy. Per the repo's
 * operator-copy rule, no branch here can surface an engine string, a unit name,
 * or a shell command — the raw diagnostic rides the backend log instead.
 */

import type { MessageFn, MessageKey } from "@ceraui/i18n/svelte";

/** The subset of the facade's `m` these pure helpers need: keyed lookup only. */
type Messages = Readonly<Record<MessageKey, MessageFn>>;

export const DEVICE_MODE_UNSUPPORTED_ERROR = "device_mode_unsupported";

export function encoderSaveErrorMessage(
	error: string | undefined,
	msg: Messages,
): string {
	if (error === DEVICE_MODE_UNSUPPORTED_ERROR) {
		return msg["live.encoder.deviceModeUnsupported"]();
	}
	return msg["notifications.saveFailed"]();
}
