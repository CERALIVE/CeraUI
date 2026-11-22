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

/* Notification system */
/*
  conn - send it to a specific client, or undefined to broadcast
  name - identifier for the notification, e.g. 'cerastream'
  type - 'success', 'warning', 'error'
  msg - the human readable notification message
  duration - 0-never expires
             or number of seconds until the notification expires
             * an expired notification is hidden by the UI and removed from persistent notifications
  isPersistent - show it to every new client, conn must be undefined for broadcast
  isDismissable - is the user allowed to hide it?
*/

import type { NotificationAction, NotificationType } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { getms } from "../../helpers/time.ts";
import {
	getAuthenticatedClients,
	socketSessionSignal,
} from "../../rpc/context.ts";
import { sendToClient } from "../../rpc/events.ts";
import type { AppWebSocket } from "../../rpc/types.ts";
import type { MessageSocket } from "./message-socket.ts";
import {
	isNotificationDismissed,
	recordNotificationDismissal,
} from "./notification-dismissals.ts";
import { notificationRemaining } from "./notification-liveness.ts";
import {
	broadcastMsg,
	buildMsg,
	getSocketSenderId,
} from "./websocket-server.ts";

type Notification = {
	name: string;
	// The SHARED wire enum, not a local re-spelling of it. The local union used
	// to omit `info`, which the wire schema and BOTH render surfaces (the toast
	// host's `toast[type]`, the panel's icon/tone maps) have always accepted —
	// so a calm informational notification was unrepresentable here for no
	// reason other than drift. Importing the type is what stops it recurring.
	type: NotificationType;
	msg: string;
	key?: string;
	params?: Record<string, unknown>;
	duration: number;
	isPersistent: boolean;
	isDismissable: boolean;
	authedOnly: boolean;
	action?: NotificationAction;
	dismissalKey?: string;
	releaseScoped?: boolean;
	beforeDismiss?: () => void;
	onDismiss?: () => void;
};

type PersistentNotification = Notification & {
	isPersistent: true;
	last_sent: number;
	updated: number;
	revision: number;
	// The revision that first carried the current dismissalKey.
	releaseRevision: number;
};

/** What a client says it saw when it dismisses: the shown revision and its publisher. */
export type NotificationSeen = {
	readonly revision?: number | undefined;
	readonly publisher?: string | undefined;
};

export type NotificationOptions = {
	action?: NotificationAction;
	dismissalKey?: string;
	/**
	 * The name carries one release at a time (its dismissalKey changes with it):
	 * a durable dismissal must attest the current release, and a dismissal is
	 * broadcast like {@link notificationWithdraw}.
	 */
	releaseScoped?: boolean;
	beforeDismiss?: () => void;
	/** A producer's durable acknowledgement must succeed before removal. */
	onDismiss?: () => void;
};

const persistentNotifications = new Map<string, PersistentNotification>();
// An owner's frames for each authenticating client, after the show replay.
// Revisions start over when the backend restarts; this namespaces them.
const publisher: string = crypto.randomUUID();
let revisionCounter = 0;
function nextRevision(): number {
	return ++revisionCounter;
}

export function buildNotificationMsg(
	n: Notification,
	duration: number,
	revision?: number,
) {
	return {
		name: n.name,
		type: n.type,
		msg: n.msg,
		// Omit key/params when absent so legacy msg-only notifications keep their wire shape.
		...(n.key !== undefined ? { key: n.key } : {}),
		...(n.params !== undefined ? { params: n.params } : {}),
		...(n.action !== undefined ? { action: n.action } : {}),
		...(revision !== undefined ? { revision, publisher } : {}),
		is_dismissable: n.isDismissable,
		is_persistent: n.isPersistent,
		duration,
	};
}

export function notificationSend(
	conn: MessageSocket | undefined,
	name: Notification["name"],
	type: Notification["type"],
	msg: Notification["msg"],
	duration = 0,
	isPersistent = false,
	isDismissable = true,
	authedOnly = true,
	key?: Notification["key"],
	params?: Notification["params"],
	opts?: NotificationOptions,
) {
	if (isPersistent && conn !== undefined) {
		logger.error("error: attempted to send persistent unicast notification");
		return false;
	}

	// A persistent notification carrying a semantic dismissal key that the
	// operator already dismissed stays suppressed across reloads and restarts.
	const dismissalKey = opts?.dismissalKey;
	if (isPersistent && dismissalKey) {
		try {
			if (isNotificationDismissed(dismissalKey)) return false;
		} catch (error) {
			logger.warn("Notification deferred: dismissal store unavailable", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	const notification: Notification = {
		name,
		type,
		msg,
		...(key !== undefined ? { key } : {}),
		...(params !== undefined ? { params } : {}),
		...(opts?.action !== undefined ? { action: opts.action } : {}),
		...(dismissalKey !== undefined ? { dismissalKey } : {}),
		...(opts?.releaseScoped ? { releaseScoped: true } : {}),
		...(opts?.beforeDismiss ? { beforeDismiss: opts.beforeDismiss } : {}),
		...(opts?.onDismiss ? { onDismiss: opts.onDismiss } : {}),
		isDismissable,
		isPersistent,
		duration,
		authedOnly,
	};
	let doSend = true;
	let revision: number | undefined;
	if (isPersistent) {
		let pn = persistentNotifications.get(name);
		if (pn) {
			const releaseChanged = pn.dismissalKey !== dismissalKey;
			// Rate limiting to once every second. A release-scoped notice's new release is
			// always sent: every connected tab must hold the copy the slot now names.
			if (
				pn.last_sent &&
				pn.last_sent + 1000 > getms() &&
				!(opts?.releaseScoped && releaseChanged)
			) {
				doSend = false;
			}
			Object.assign(pn, notification);
			pn.updated = getms();
			pn.revision = nextRevision();
			if (releaseChanged) pn.releaseRevision = pn.revision;
			if (doSend) {
				pn.last_sent = getms();
			}
		} else {
			const first = nextRevision();
			pn = {
				...notification,
				isPersistent: true,
				last_sent: 0,
				updated: getms(),
				revision: first,
				releaseRevision: first,
			};
			persistentNotifications.set(name, pn);
		}
		revision = pn.revision;
	}

	if (!doSend) return;

	const notificationMsg = {
		show: [buildNotificationMsg(notification, duration, revision)],
	};
	if (conn) {
		const senderId = getSocketSenderId(conn);
		if (senderId) {
			conn.send(buildMsg("notification", notificationMsg, senderId));
		}
	} else {
		broadcastMsg("notification", notificationMsg, 0, authedOnly);
	}

	return true;
}

export function notificationBroadcast(
	name: Notification["name"],
	type: Notification["type"],
	msg: Notification["msg"],
	duration = 0,
	isPersistent = false,
	isDismissable = true,
	authedOnly = true,
	key?: Notification["key"],
	params?: Notification["params"],
	opts?: NotificationOptions,
) {
	notificationSend(
		undefined,
		name,
		type,
		msg,
		duration,
		isPersistent,
		isDismissable,
		authedOnly,
		key,
		params,
		opts,
	);
}

function removeNotification(
	name: string,
	legacy: boolean,
	recipients?: readonly AppWebSocket[],
) {
	const n = persistentNotifications.get(name);
	persistentNotifications.delete(name);

	const revision = nextRevision();
	const msg = { remove: [{ id: name, revision }] };
	const authedOnly = !n || n.authedOnly;
	if (recipients === undefined) {
		broadcastMsg("notification", msg, 0, authedOnly);
		if (legacy)
			broadcastMsg("notification", legacyRemoval([name]), 0, authedOnly);
	} else {
		for (const socket of recipients) {
			sendToClient(socket, "notification", msg);
			if (legacy) sendToClient(socket, "notification", legacyRemoval([name]));
		}
	}
	return msg;
}

// Frontends before #183 (July 2026) remove by bare name and ignore typed
// entries; current frontends reject this frame and use the typed one.
function legacyRemoval(names: readonly string[]) {
	return { remove: [...names] };
}

export function notificationRemove(name: string) {
	return removeNotification(name, false);
}

/**
 * Removes `name` live, as a typed and a separate pre-#183 frame. A client that
 * was offline is not told: a login is sent only what is shown now.
 */
export function notificationWithdraw(
	name: string,
	recipients?: readonly AppWebSocket[],
) {
	return removeNotification(name, true, recipients);
}

/** The authenticated sessions now, captured before the evidence for a removal is read. */
export function captureNotificationAudience(): ReadonlySet<AbortSignal> {
	return new Set(getAuthenticatedClients().map(socketSessionSignal));
}

/** The sockets still in a captured session, and whether any session authenticated since. */
export function liveNotificationAudience(snapshot: ReadonlySet<AbortSignal>) {
	const active = getAuthenticatedClients();
	const recipients = active.filter((socket) =>
		snapshot.has(socketSessionSignal(socket)),
	);
	return { recipients, hasLateSessions: recipients.length !== active.length };
}

// Persists the dismissal (survives reload + restart) only when the notification
// carries a semantic dismissalKey; a keyless notification is merely removed.
// A release-scoped notice is dismissed only by a client that saw its current
// release; an attested older view gets the current release back instead, and
// a client that cannot attest (an older frontend) changes nothing.
export function notificationDismiss(
	name: string,
	seen: NotificationSeen = {},
	requester?: MessageSocket,
) {
	const pn = persistentNotifications.get(name);
	if (pn?.releaseScoped && !sawCurrentRelease(pn, seen)) {
		if (requester && seen.revision !== undefined) resend(requester, pn);
		return undefined;
	}
	pn?.onDismiss?.();
	if (pn?.beforeDismiss) {
		pn.beforeDismiss();
	} else if (pn?.dismissalKey) {
		recordNotificationDismissal(pn.dismissalKey);
	}
	return removeNotification(name, pn?.releaseScoped === true);
}

function sawCurrentRelease(
	pn: PersistentNotification,
	seen: NotificationSeen,
): boolean {
	return (
		seen.publisher === publisher &&
		seen.revision !== undefined &&
		seen.revision >= pn.releaseRevision &&
		seen.revision <= pn.revision
	);
}

function resend(conn: MessageSocket, pn: PersistentNotification): void {
	const remaining = _notificationIsLive(pn);
	if (remaining === false) return;
	conn.send(
		buildMsg(
			"notification",
			{ show: [buildNotificationMsg(pn, remaining, pn.revision)] },
			getSocketSenderId(conn),
		),
	);
}

function _notificationIsLive(
	n: PersistentNotification,
	nowMs: number = getms(),
) {
	const remaining = notificationRemaining({
		isPersistent: n.isPersistent,
		duration: n.duration,
		updatedMs: n.updated,
		nowMs,
	});
	if (remaining === false) {
		persistentNotifications.delete(n.name);
	}
	return remaining;
}

export function notificationExists(name: string, nowMs: number = getms()) {
	const pn = persistentNotifications.get(name);
	if (!pn) return;

	if (_notificationIsLive(pn, nowMs) !== false) return pn;
	return undefined;
}

export function getPersistentNotifications(
	isAuthed = false,
	nowMs: number = getms(),
) {
	const notifications = [];
	for (const n of persistentNotifications) {
		if (!isAuthed && n[1].authedOnly) continue;

		const remainingDuration = _notificationIsLive(n[1], nowMs);
		if (remainingDuration !== false) {
			notifications.push(
				buildNotificationMsg(n[1], remainingDuration, n[1].revision),
			);
		}
	}

	return { show: notifications };
}

export function notificationSendPersistent(
	conn: MessageSocket,
	isAuthed = false,
) {
	conn.send(
		buildMsg("notification", {
			...getPersistentNotifications(isAuthed),
			replay: true,
		}),
	);
}
