import { notificationExists, notificationRemove, notificationSend } from "../../ui/notifications.ts";

export type UpdateNotice =
	| { readonly kind: "updates-available"; readonly id: string }
	| { readonly kind: "installed"; readonly id: string; readonly packages: readonly string[] }
	| { readonly kind: "refused"; readonly id: string; readonly reason: string }
	| { readonly kind: "download-paused"; readonly id: string }
	| { readonly kind: "os-staged"; readonly id: string; readonly version: string }
	| { readonly kind: "os-activated"; readonly id: string; readonly version: string }
	| { readonly kind: "os-rollback"; readonly id: string; readonly version: string }
	| { readonly kind: "slots-current"; readonly id: string }
	| { readonly kind: "restart-recommended"; readonly id: string; readonly unit: string }
	| { readonly kind: "cellular-approval"; readonly id: string; readonly size: string }
	| { readonly kind: "credentials-expiring"; readonly id: string; readonly days: 90 | 30 | 7 }
	| { readonly kind: "transport-unhealthy"; readonly id: string; readonly reasons: readonly string[] };

const notices = {
	"updates-available": { key: "notifications.updateAvailable", tone: "info" },
	installed: { key: "notifications.updateInstalled", tone: "success" },
	refused: { key: "notifications.updateRefused", tone: "warning" },
	"download-paused": { key: "notifications.updatePausedForStream", tone: "info" },
	"os-staged": { key: "notifications.updateSystemStaged", tone: "info" },
	"os-activated": { key: "notifications.updateSystemActivated", tone: "success" },
	"os-rollback": { key: "notifications.updateRollback", tone: "error" },
	"slots-current": { key: "notifications.updateSlotsCurrent", tone: "success" },
	"restart-recommended": { key: "notifications.updateRestartRecommended", tone: "warning" },
	"cellular-approval": { key: "notifications.updateCellularApproval", tone: "warning" },
	"credentials-expiring": { key: "notifications.updateCredentialsExpiring", tone: "warning" },
	"transport-unhealthy": { key: "notifications.updateTransportUnhealthy", tone: "warning" },
} as const;

/** Stable identity = event kind + exact transaction/version/unit; a retry is silent. */
export function notifyUpdate(event: UpdateNotice): boolean {
	const name = `update:${event.kind}:${event.id}`;
	if (notificationExists(name)) return false;
	const notice = notices[event.kind];
	const params: Record<string, string | number> = {};
	switch (event.kind) {
		case "installed": params.packages = event.packages.join(", "); break;
		case "refused": params.reason = event.reason; break;
		case "os-staged": case "os-activated": case "os-rollback": params.version = event.version; break;
		case "restart-recommended": params.unit = event.unit; break;
		case "cellular-approval": params.size = event.size; break;
		case "credentials-expiring": params.days = event.days; break;
		case "transport-unhealthy": params.reasons = event.reasons.join(", "); break;
		case "updates-available": case "download-paused": case "slots-current": break;
		default: { const exhaustive: never = event; return exhaustive; }
	}
	return notificationSend(undefined, name, notice.tone, notice.key, 0, true, true, true, notice.key, params, {
		action: { schema: 1, kind: "navigate", target: "updates-dialog", labelKey: "notifications.openUpdates" },
		dismissalKey: name,
	}) === true;
}

export function clearUpdateNotice(kind: UpdateNotice["kind"], id: string): void {
	const name = `update:${kind}:${id}`;
	if (notificationExists(name)) notificationRemove(name);
}
