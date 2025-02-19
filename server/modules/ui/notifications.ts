/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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
  name - identifier for the notification, e.g. 'belacoder'
  type - 'success', 'warning', 'error'
  msg - the human readable notification message
  duration - 0-never expires
             or number of seconds until the notification expires
             * an expired notification is hidden by the UI and removed from persistent notifications
  isPersistent - show it to every new client, conn must be undefined for broadcast
  isDismissable - is the user allowed to hide it?
*/

import type WebSocket from "ws";

import { getms } from "../../helpers/time.ts";

import { logger } from "../../helpers/logger.ts";
import {
	broadcastMsg,
	buildMsg,
	getSocketSenderId,
} from "./websocket-server.ts";

type Notification = {
	name: string;
	type: "success" | "warning" | "error";
	msg: string;
	duration: number;
	isPersistent: boolean;
	isDismissable: boolean;
	authedOnly: boolean;
};

type PersistentNotification = Notification & {
	isPersistent: true;
	last_sent: number;
	updated: number;
};

const persistentNotifications = new Map<string, PersistentNotification>();

function buildNotificationMsg(n: Notification, duration: number) {
	return {
		name: n.name,
		type: n.type,
		msg: n.msg,
		is_dismissable: n.isDismissable,
		is_persistent: n.isPersistent,
		duration,
	};
}

export function notificationSend(
	conn: WebSocket | undefined,
	name: Notification["name"],
	type: Notification["type"],
	msg: Notification["msg"],
	duration = 0,
	isPersistent = false,
	isDismissable = true,
	authedOnly = true,
) {
	if (isPersistent && conn !== undefined) {
		logger.error("error: attempted to send persistent unicast notification");
		return false;
	}

	const notification: Notification = {
		name,
		type,
		msg,
		isDismissable,
		isPersistent,
		duration,
		authedOnly,
	};
	let doSend = true;
	if (isPersistent) {
		let pn = persistentNotifications.get(name);
		if (pn) {
			// Rate limiting to once every second
			if (pn.last_sent && pn.last_sent + 1000 > getms()) {
				doSend = false;
			}
			Object.assign(pn, notification);
			pn.updated = getms();
			if (doSend) {
				pn.last_sent = getms();
			}
		} else {
			pn = {
				...notification,
				isPersistent: true,
				last_sent: 0,
				updated: getms(),
			};
			persistentNotifications.set(name, pn);
		}
	}

	if (!doSend) return;

	const notificationMsg = {
		show: [buildNotificationMsg(notification, duration)],
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
	);
}

export function notificationRemove(name: string) {
	const n = persistentNotifications.get(name);
	persistentNotifications.delete(name);

	const msg = { remove: [name] };
	broadcastMsg("notification", msg, 0, !n || n.authedOnly);
}

function _notificationIsLive(n: PersistentNotification) {
	if (n.duration === 0) return 0;

	const remainingDuration = Math.ceil(
		n.duration - (getms() - n.updated) / 1000,
	);
	if (remainingDuration <= 0) {
		persistentNotifications.delete(n.name);
		return false;
	}
	return remainingDuration;
}

export function notificationExists(name: string) {
	const pn = persistentNotifications.get(name);
	if (!pn) return;

	if (_notificationIsLive(pn) !== false) return pn;
}

export function notificationSendPersistent(conn: WebSocket, isAuthed = false) {
	const notifications = [];
	for (const n of persistentNotifications) {
		if (!isAuthed && n[1].authedOnly) continue;

		const remainingDuration = _notificationIsLive(n[1]);
		if (remainingDuration !== false) {
			notifications.push(buildNotificationMsg(n[1], remainingDuration));
		}
	}

	const msg = { show: notifications };
	conn.send(buildMsg("notification", msg));
}
