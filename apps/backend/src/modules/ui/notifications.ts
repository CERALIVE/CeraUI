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

import type { NotificationAction } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { getms } from "../../helpers/time.ts";
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
	type: "success" | "warning" | "error";
	msg: string;
	key?: string;
	params?: Record<string, unknown>;
	duration: number;
	isPersistent: boolean;
	isDismissable: boolean;
	authedOnly: boolean;
	action?: NotificationAction;
	dismissalKey?: string;
};

type PersistentNotification = Notification & {
	isPersistent: true;
	last_sent: number;
	updated: number;
	revision: number;
};

export type NotificationOptions = {
	action?: NotificationAction;
	dismissalKey?: string;
};

const persistentNotifications = new Map<string, PersistentNotification>();

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
		...(revision !== undefined ? { revision } : {}),
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
	if (isPersistent && dismissalKey && isNotificationDismissed(dismissalKey)) {
		return false;
	}

	const notification: Notification = {
		name,
		type,
		msg,
		...(key !== undefined ? { key } : {}),
		...(params !== undefined ? { params } : {}),
		...(opts?.action !== undefined ? { action: opts.action } : {}),
		...(dismissalKey !== undefined ? { dismissalKey } : {}),
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
			// Rate limiting to once every second
			if (pn.last_sent && pn.last_sent + 1000 > getms()) {
				doSend = false;
			}
			Object.assign(pn, notification);
			pn.updated = getms();
			pn.revision = nextRevision();
			if (doSend) {
				pn.last_sent = getms();
			}
		} else {
			pn = {
				...notification,
				isPersistent: true,
				last_sent: 0,
				updated: getms(),
				revision: nextRevision(),
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

export function notificationRemove(name: string) {
	const n = persistentNotifications.get(name);
	persistentNotifications.delete(name);

	const msg = { remove: [{ id: name, revision: nextRevision() }] };
	broadcastMsg("notification", msg, 0, !n || n.authedOnly);
	return msg;
}

// Persists the dismissal (survives reload + restart) only when the notification
// carries a semantic dismissalKey; a keyless notification is merely removed.
export function notificationDismiss(name: string) {
	const pn = persistentNotifications.get(name);
	if (pn?.dismissalKey) {
		recordNotificationDismissal(pn.dismissalKey);
	}
	return notificationRemove(name);
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
	conn.send(buildMsg("notification", getPersistentNotifications(isAuthed)));
}
