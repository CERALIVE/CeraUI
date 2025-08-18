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

/* Notifications */
function notificationId(name: string) {
	return `notification-${name}`;
}

export function showNotification(n: {
	name?: string;
	type?: string;
	msg?: string;
	duration?: number;
	is_dismissable?: boolean;
}) {
	if (!n.name || !n.type || !n.msg) return;
	const alertId = notificationId(n.name);

	let alert: JQuery<Node[] | HTMLElement> = $(`#${alertId}`);
	if (alert.length === 0) {
		const html = `
      <div class="alert mb-2">
        <span class="msg"></span>
        <button type="button" class="close d-none" data-dismiss="alert" aria-label="Close">
          <span aria-hidden="true">&times;</span>
        </button>
      </div>`;
		alert = $($.parseHTML(html));

		alert.attr("id", alertId);
		if (n.is_dismissable) {
			alert.addClass("alert-dismissible");
			alert.find("button").removeClass("d-none");
		}

		alert.appendTo("#notifications");

		// If we've shown a new notification, scroll to the top
		$("html, body").animate(
			{
				scrollTop: 0,
				scrollLeft: 0,
			},
			200,
		);
	} else {
		alert.removeClass([
			"alert-secondary",
			"alert-danger",
			"alert-warning",
			"alert-success",
		]);
		const t = alert.data("timerHide");
		if (t) {
			clearTimeout(t);
		}
	}

	const colorClass = "alert-secondary";
	switch (n.type) {
		case "error":
			alert.addClass("alert-danger");
			break;
		case "warning":
		case "success":
			alert.addClass(`alert-${n.type}`);
			break;
	}
	alert.addClass(colorClass);

	alert.find("span.msg").text(n.msg);

	if (n.duration) {
		alert.data(
			"timerHide",
			setTimeout(() => {
				alert.slideUp(300, function () {
					$(this).remove();
				});
			}, n.duration * 1000),
		);
	}
}

export function removeNotification(name: string) {
	const alertId = notificationId(name);
	$(`#${alertId}`).remove();
}

export function handleNotification(msg: {
	show?: { name: string; type: string; msg: string; duration: number }[];
	remove?: string[];
}) {
	if (msg.show) {
		for (const n of msg.show) {
			showNotification(n);
		}
	}
	if (msg.remove) {
		for (const n of msg.remove) {
			removeNotification(n);
		}
	}
}
