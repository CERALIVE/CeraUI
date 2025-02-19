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

import { resetModems } from "../modems/modems.ts";
import { resetWifiInterfaces } from "../wifi/wifi.ts";
import { hideError } from "./error-message.ts";
import { getIsShowingInitialPasswordForm, showLoginForm } from "./login.ts";
import { ws } from "./websocket.ts";

/* Authentication */
export function tryTokenAuth() {
	const authToken = localStorage.getItem("authToken");
	if (authToken) {
		ws?.send(JSON.stringify({ auth: { token: authToken } }));
	} else {
		showLoginForm();
	}
}

export function handleAuthResult(msg: {
	success?: boolean;
	auth_token?: string;
}) {
	if (msg.success === true) {
		if (msg.auth_token) {
			localStorage.setItem("authToken", msg.auth_token);
		}
		// Reset state
		resetModems();
		resetWifiInterfaces();

		// Reset the UI
		$("#login").addClass("d-none");
		$("#initialPasswordForm").addClass("d-none");
		hideError();
		$("#notifications").empty();
		$("#wifi").empty();
		$("#modemManager").empty();
		$("#main").removeClass("d-none");
		$("#themeSelector").removeClass("d-none");
	} else if (!getIsShowingInitialPasswordForm()) {
		showLoginForm();
	}
}
