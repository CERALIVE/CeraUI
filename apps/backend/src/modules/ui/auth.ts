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

/* Authentication */
import crypto from "node:crypto";
import fs from "node:fs";

import type WebSocket from "ws";

import { getConfig, saveConfig } from "../config.ts";
import { notificationSend } from "./notifications.ts";
import { sendInitialStatus } from "./status.ts";
import { buildMsg } from "./websocket-server.ts";

export type AuthMessage = {
	auth: {
		password?: unknown;
		token?: unknown;
		persistent_token: boolean;
	};
};

type AuthResultMessage = {
	success: boolean;
	auth_token?: string;
};

const AUTH_TOKENS_FILE = "auth_tokens.json";
const BCRYPT_ROUNDS = 10;

/* tempTokens stores temporary login tokens in memory */
const tempTokens: Record<string, true> = {};

/* persistentTokens stores login tokens to the disc */
let persistentTokens: Record<string, true>;
try {
	persistentTokens = JSON.parse(fs.readFileSync(AUTH_TOKENS_FILE, "utf8"));
} catch (_err) {
	persistentTokens = {};
}

let passwordHash: string | undefined;

export function setPasswordHash(newHash: string | undefined) {
	passwordHash = newHash;
}

export function getPasswordHash() {
	return passwordHash;
}

const authTokens = new WeakMap<WebSocket, string>();
const authedSockets = new WeakSet<WebSocket>();

function savePersistentTokens() {
	fs.writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(persistentTokens));
}

export function isAuthedSocket(conn: WebSocket) {
	return authedSockets.has(conn);
}

export function addAuthedSocket(conn: WebSocket) {
	authedSockets.add(conn);
}

export function deleteAuthedSocket(conn: WebSocket) {
	authedSockets.delete(conn);
}

export function setPassword(
	conn: WebSocket,
	password: string,
	isRemote: boolean,
) {
	const isAuthed = isAuthedSocket(conn);
	if (isAuthed || (!isRemote && !passwordHash)) {
		const minLen = 8;
		if (password.length < minLen) {
			notificationSend(
				conn,
				"belaui_pass_length",
				"error",
				`Minimum password length: ${minLen} characters`,
				10,
			);
			return;
		}
		passwordHash = Bun.password.hashSync(password, {
			algorithm: "bcrypt",
			cost: BCRYPT_ROUNDS,
		});
		const config = getConfig();
		config.password = undefined;
		saveConfig();
	}
}

function genAuthToken(isPersistent: boolean) {
	const token = crypto.randomBytes(32).toString("base64");
	if (isPersistent) {
		persistentTokens[token] = true;
		savePersistentTokens();
	} else {
		tempTokens[token] = true;
	}
	return token;
}

function connAuth(conn: WebSocket, sendToken?: string) {
	addAuthedSocket(conn);
	const result: AuthResultMessage = { success: true };
	if (sendToken !== undefined) {
		result.auth_token = sendToken;
	}
	conn.send(buildMsg("auth", result));
	sendInitialStatus(conn);
}

export async function tryAuth(conn: WebSocket, msg: AuthMessage["auth"]) {
	if (!passwordHash) {
		conn.send(buildMsg("auth", { success: false }));
		return;
	}

	if (typeof msg.password === "string") {
		try {
			const match = await Bun.password.verify(
				msg.password,
				passwordHash,
				"bcrypt",
			);
			if (match) {
				const token = genAuthToken(msg.persistent_token);
				authTokens.set(conn, token);
				connAuth(conn, token);
				return;
			}
		} catch (_) {}

		notificationSend(conn, "auth", "error", "Invalid password");
	} else if (typeof msg.token === "string") {
		if (tempTokens[msg.token] || persistentTokens[msg.token]) {
			connAuth(conn);
			authTokens.set(conn, msg.token);
		} else {
			conn.send(buildMsg("auth", { success: false }));
		}
	}
}

export function handleLogout(conn: WebSocket) {
	const token = authTokens.get(conn);
	if (token) {
		delete tempTokens[token];
		if (persistentTokens[token]) {
			delete persistentTokens[token];
			savePersistentTokens();
		}
	}
	deleteAuthedSocket(conn);
	authTokens.delete(conn);
}

function isRecord(obj: unknown): obj is Record<string, unknown> {
	return obj
		? typeof obj === "object" &&
				!Array.isArray(obj) &&
				Object.getOwnPropertySymbols(obj).length <= 0
		: false;
}

export function stripPasswords(obj: unknown) {
	if (!isRecord(obj)) return obj;

	const copy = { ...obj };
	for (const p in copy) {
		if (p === "password") {
			copy[p] = "<password not logged>";
		} else if (p in copy) {
			copy[p] = stripPasswords(copy[p]);
		}
	}
	return copy;
}
