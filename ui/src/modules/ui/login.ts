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

import { ws } from "./websocket.ts";

export function showLoginForm() {
	$("#main").addClass("d-none");
	$("#initialPasswordForm").addClass("d-none");
	$("#login").removeClass("d-none");
	$("#themeSelector").removeClass("d-none");
}

function sendAuthMsg(password: string, isPersistent: boolean) {
	const auth_req = { auth: { password, persistent_token: isPersistent } };
	ws?.send(JSON.stringify(auth_req));
}

let isShowingInitialPasswordForm = false;
export function getIsShowingInitialPasswordForm() {
	return isShowingInitialPasswordForm;
}

export function showInitialPasswordForm() {
	$("#main").addClass("d-none");
	$("#login").addClass("d-none");
	$("#initialPasswordForm").removeClass("d-none");
	$("#themeSelector").removeClass("d-none");
	isShowingInitialPasswordForm = true;
}

function sendPasswordFromInput(form: HTMLElement) {
	const passwordInput = $(form).find("input.set-password");
	const password = String(passwordInput.val());

	passwordInput.val("");
	$(form).find("button[type=submit]").prop("disabled", true);

	ws?.send(JSON.stringify({ config: { password } }));

	return password;
}

export function initLogin() {
	$("#login>form").on("submit", () => {
		const password = String($("#password").val());
		const rememberMe = $("#login .rememberMe").prop("checked");
		sendAuthMsg(password, rememberMe);

		$("#password").val("");

		return false;
	});

	$(".set-password").on("input", function () {
		const form = $(this).parents("form");

		const p = String($(this).val());
		let isValid = false;

		if (p.length < 8) {
			$(form).find(".hint").text("Minimum length: 8 characters");
		} else {
			$(form).find(".hint").text("");
			isValid = true;
		}

		$(form).find("button[type=submit]").prop("disabled", !isValid);
	});

	$("#initialPasswordForm form").on("submit", function () {
		const password = sendPasswordFromInput(this);
		const remember = $(this).find(".rememberMe").prop("checked");
		sendAuthMsg(password, remember);

		return false;
	});

	$("form#updatePasswordForm").on("submit", function () {
		sendPasswordFromInput(this);

		return false;
	});

	$("#logout").on("click", () => {
		localStorage.removeItem("authToken");
		ws?.send(JSON.stringify({ logout: true }));
		showLoginForm();
	});
}
