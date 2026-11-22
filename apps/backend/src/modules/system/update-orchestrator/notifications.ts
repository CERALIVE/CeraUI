import type { EventCode } from "@ceraui/rpc/events";
import { logger } from "../../../helpers/logger.ts";
import { emitEvent } from "../../events/emit.ts";
import {
	hasLiveNotificationForDismissal,
	type NotificationOptions,
	notificationExists,
	notificationRemove,
	notificationSend,
} from "../../ui/notifications.ts";
import type { UpdateQuarantine } from "./quarantine.ts";

export type UpdateNotice =
	| {
			readonly kind: "packages-recovered" | "slot-sync-recovered";
			readonly id: string;
	  }
	| { readonly kind: "updates-available"; readonly id: string }
	| {
			readonly kind: "installed";
			readonly id: string;
			readonly packages: readonly string[];
	  }
	| { readonly kind: "refused"; readonly id: string; readonly reason: string }
	| { readonly kind: "download-paused"; readonly id: string }
	| {
			readonly kind: "os-staged";
			readonly id: string;
			readonly version: string;
	  }
	| {
			readonly kind: "os-activation-requested";
			readonly id: string;
			readonly version: string;
	  }
	| {
			readonly kind: "os-activated";
			readonly id: string;
			readonly version: string;
	  }
	| {
			readonly kind: "os-rollback";
			readonly id: string;
			readonly version: string;
	  }
	| { readonly kind: "slots-current"; readonly id: string }
	| {
			readonly kind: "restart-recommended";
			readonly id: string;
			readonly unit: string;
	  }
	| {
			readonly kind: "cellular-approval";
			readonly id: string;
			readonly size: string;
	  }
	| {
			readonly kind: "credentials-expiring";
			readonly id: string;
			readonly days: 90 | 30 | 7;
	  }
	| { readonly kind: "credentials-expired"; readonly id: string }
	| {
			readonly kind: "transport-unhealthy";
			readonly id: string;
			readonly reasons: readonly string[];
	  }
	| {
			readonly kind:
				| "kernel-staged"
				| "kernel-succeeded"
				| "kernel-rolled-back";
			readonly id: string;
			readonly version: string;
	  }
	| {
			readonly kind: OsStageNoticeKind;
			readonly id: string;
			readonly version: string;
	  };

export const OS_STAGE_NOTICE_KINDS = [
	"os-stage-retry",
	"os-stage-operator",
	"os-stage-unresolved",
] as const;
export type OsStageNoticeKind = (typeof OS_STAGE_NOTICE_KINDS)[number];

const notices = {
	"kernel-staged": { key: "settings.updates.phase.kernelStaged", tone: "info" },
	"kernel-succeeded": {
		key: "settings.updates.phase.kernelSucceeded",
		tone: "success",
	},
	"kernel-rolled-back": {
		key: "settings.updates.phase.kernelRolledBack",
		tone: "error",
	},
	"packages-recovered": {
		key: "notifications.updatePackagesRecovered",
		tone: "info",
	},
	"slot-sync-recovered": {
		key: "notifications.updateSlotSyncRecovered",
		tone: "info",
	},
	// Own key, not the shared `notifications.updateAvailable` title: the banner
	// sentence and the title were never the same string, and reusing one key
	// duplicated it in the catalog, where last-key-wins dropped the other.
	"updates-available": {
		key: "notifications.updatesAvailableMessage",
		tone: "info",
	},
	installed: { key: "notifications.updateInstalled", tone: "success" },
	refused: { key: "notifications.updateRefused", tone: "warning" },
	"download-paused": {
		key: "notifications.updatePausedForStream",
		tone: "info",
	},
	"os-staged": { key: "notifications.updateSystemStaged", tone: "info" },
	"os-activation-requested": {
		key: "notifications.updateSystemActivationRequested",
		tone: "info",
	},
	"os-activated": {
		key: "notifications.updateSystemActivated",
		tone: "success",
	},
	"os-rollback": { key: "notifications.updateRollback", tone: "error" },
	"slots-current": { key: "notifications.updateSlotsCurrent", tone: "success" },
	"restart-recommended": {
		key: "notifications.updateRestartRecommended",
		tone: "warning",
	},
	"cellular-approval": {
		key: "notifications.updateCellularApproval",
		tone: "warning",
	},
	"credentials-expiring": {
		key: "notifications.updateCredentialsExpiring",
		tone: "warning",
	},
	"credentials-expired": {
		key: "notifications.updateCredentialsExpired",
		tone: "error",
	},
	"transport-unhealthy": {
		key: "notifications.updateTransportUnhealthy",
		tone: "warning",
	},
	"os-stage-retry": {
		key: "notifications.updateSystemStageRetry",
		tone: "info",
	},
	"os-stage-operator": {
		key: "notifications.updateSystemStageOperator",
		tone: "warning",
	},
	"os-stage-unresolved": {
		key: "notifications.updateSystemStageUnresolved",
		tone: "error",
	},
} as const;

const eventCodes = {
	"packages-recovered": "update_packages_recovered",
	"slot-sync-recovered": "update_slot_sync_recovered",
	"updates-available": "update_updates_available",
	installed: "update_installed",
	refused: "update_refused",
	"download-paused": "update_download_paused",
	"os-staged": "update_os_staged",
	"os-activation-requested": "update_os_activation_requested",
	"os-activated": "update_os_activated",
	"os-rollback": "update_os_rollback",
	"slots-current": "update_slots_current",
	"restart-recommended": "update_restart_recommended",
	"cellular-approval": "update_cellular_approval",
	"credentials-expiring": "update_credentials_expiring",
	"credentials-expired": "update_credentials_expired",
	"transport-unhealthy": "update_transport_unhealthy",
	"kernel-staged": "update_kernel_staged",
	"kernel-succeeded": "update_kernel_succeeded",
	"kernel-rolled-back": "update_kernel_rolled_back",
	"os-stage-retry": "update_os_stage_retry",
	"os-stage-operator": "update_os_stage_operator",
	"os-stage-unresolved": "update_os_stage_unresolved",
} as const satisfies Record<UpdateNotice["kind"], EventCode>;

/** Stable identity = event kind + exact transaction/version/unit; a retry is silent. */
export function notifyUpdate(
	event: UpdateNotice,
	options: Pick<NotificationOptions, "beforeDismiss" | "onDismiss"> & {
		readonly deliveryId?: string;
	} = {},
): boolean {
	// History is independent of whether the operator has seen or dismissed the notice.
	try {
		switch (event.kind) {
			case "installed":
				emitEvent(eventCodes[event.kind], {
					id: event.id,
					packages: [...event.packages],
				});
				break;
			case "transport-unhealthy":
				emitEvent(eventCodes[event.kind], {
					id: event.id,
					reasons: [...event.reasons],
				});
				break;
			default: {
				const { kind, ...params } = event;
				emitEvent(eventCodes[kind], params);
			}
		}
	} catch {
		// Event history must not interrupt notification publication.
	}
	const { deliveryId = event.id, ...hooks } = options;
	const name = `update:${event.kind}:${deliveryId}`;
	const dismissalKey = `update:${event.kind}:${event.id}`;
	if (
		notificationExists(name) ||
		(options.deliveryId !== undefined &&
			hasLiveNotificationForDismissal(dismissalKey))
	)
		return false;
	const notice = notices[event.kind];
	const params: Record<string, string | number> = {};
	switch (event.kind) {
		case "installed":
			params.packages = event.packages.join(", ");
			break;
		case "refused":
			// The frontend shows a known token as its own sentence and anything
			// else as generic copy, so the raw diagnostic lives here.
			logger.warn("update-orchestrator: update refused", {
				id: event.id,
				reason: event.reason,
			});
			params.reason = event.reason;
			break;
		case "os-staged":
		case "kernel-staged":
		case "kernel-succeeded":
		case "kernel-rolled-back":
		case "os-activation-requested":
		case "os-activated":
		case "os-rollback":
		case "os-stage-retry":
		case "os-stage-operator":
		case "os-stage-unresolved":
			params.version = event.version;
			break;
		case "restart-recommended":
			params.unit = event.unit;
			break;
		case "cellular-approval":
			params.size = event.size;
			break;
		case "credentials-expiring":
			params.days = event.days;
			break;
		case "transport-unhealthy":
			params.reasons = event.reasons.join(", ");
			break;
		case "updates-available":
		case "packages-recovered":
		case "slot-sync-recovered":
		case "download-paused":
		case "credentials-expired":
		case "slots-current":
			break;
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
	return (
		notificationSend(
			undefined,
			name,
			notice.tone,
			notice.key,
			0,
			true,
			true,
			true,
			notice.key,
			params,
			{
				...hooks,
				action: {
					schema: 1,
					kind: "navigate",
					target: "updates-dialog",
					labelKey: "notifications.openUpdates",
				},
				dismissalKey,
			},
		) === true
	);
}

export function clearUpdateNotice(
	kind: UpdateNotice["kind"],
	id: string,
): void {
	const name = `update:${kind}:${id}`;
	if (notificationExists(name)) notificationRemove(name);
}

export async function hydrateOsRollbackNotices(
	quarantine: UpdateQuarantine,
): Promise<void> {
	try {
		for (const { version } of (await quarantine.read()).os)
			notifyUpdate({ kind: "os-rollback", id: version, version });
	} catch (error: unknown) {
		logger.warn("update-orchestrator: rollback notices deferred", {
			error: error instanceof Error ? error : String(error),
		});
	}
}

/** Withdraws every staging-failure notice of one exact OS candidate. */
export function clearOsStageNotices(id: string): void {
	for (const kind of OS_STAGE_NOTICE_KINDS) clearUpdateNotice(kind, id);
}

/**
 * One notice per settled staging job: the candidate's previous notice is
 * replaced, so a retry notice gives way when the policy turns operator-only.
 */
export function announceOsStageSettlement(
	kind: OsStageNoticeKind,
	id: string,
	version: string,
): boolean {
	clearOsStageNotices(id);
	return notifyUpdate({ kind, id, version });
}
