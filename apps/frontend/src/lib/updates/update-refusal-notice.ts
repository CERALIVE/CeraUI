/**
 * The `notifications.updateRefused` notice carries its `reason` as a MACHINE
 * token: a package or OS check result, an apt failure, a staging error's
 * message (C-m1). A token listed here reads as its own localized sentence; any
 * other is a diagnostic for the device log, which keeps it, and reads as copy
 * that points the operator there. The raw token is never put on screen. Pure.
 */
export const UPDATE_REFUSED_NOTICE_KEY = "notifications.updateRefused";

const REASON_KEYS: ReadonlyMap<string, string> = new Map([
	["booted_version_unknown", "settings.updates.refusal.bootedVersionUnknown"],
	["captive_portal", "settings.updates.checkFailed.captive_portal"],
	["repos_unreachable", "settings.updates.checkFailed.repos_unreachable"],
	["refresh_failed", "general.updateCheckReasonRefreshFailed"],
	["discovery_failed", "general.updateCheckReasonDiscoveryFailed"],
]);

export const UPDATE_REFUSED_GENERIC_KEY = "notifications.updateRefusedGeneric";

export function updateRefusalReasonKey(reason: unknown): string {
	return (
		(typeof reason === "string" ? REASON_KEYS.get(reason) : undefined) ??
		UPDATE_REFUSED_GENERIC_KEY
	);
}
