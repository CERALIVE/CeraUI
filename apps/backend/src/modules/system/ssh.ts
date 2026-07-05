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

/* SSH control */
import type WebSocket from "ws";

import { randomBase64 } from "../../helpers/crypto.ts";
import { execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { runWithStdin } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getConfig, saveConfig } from "../config.ts";
import { setup } from "../setup.ts";
import { notificationSend } from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { describeCliError } from "./cli-parse.ts";

type SshStatus = {
	user: string;
	active: boolean;
	// Omitted when the shadow hash is unreadable (password state unknowable).
	user_pass?: boolean;
};

/**
 * Identifier guard for `ssh_user`. Letters, digits and `_ . -` only, and the
 * value may not begin with `-` (which `passwd`/`systemctl` could otherwise
 * mis-parse as a flag — argument injection). Mirrors helpers/run.ts#ID_RE.
 */
const ID_RE = /^[A-Za-z0-9_.-]+$/;

let sshStatus: SshStatus | null = null;
let sshPasswordHash: string | undefined;

export function setSshPasswordHash(hash: string | undefined) {
	sshPasswordHash = hash;
}

export function getSshPasswordHash() {
	return sshPasswordHash;
}

/** Escape an ID_RE-validated value for safe literal use inside a RegExp. */
function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * Parse the crypt hash field for `user` out of a /etc/shadow document, in JS.
 * Returns the second colon-separated field (the password hash) or undefined
 * when there is no matching entry.
 */
function parseShadowHash(shadow: string, user: string): string | undefined {
	const re = new RegExp(`^${escapeForRegExp(user)}:([^:]*):`, "m");
	const match = shadow.match(re);
	return match ? match[1] : undefined;
}

/**
 * Injectable probe surface for {@link getSshStatus}. Defaults talk to the real
 * OS (argv-only systemctl, JS /etc/shadow read, real broadcast). Tests inject
 * deterministic stand-ins and a spy broadcast.
 */
export type SshStatusDeps = {
	/** `systemctl is-active ssh` — argv-only, may reject on non-zero exit. */
	systemctlIsActive: () => Promise<{ stdout: string; stderr: string }>;
	/** Read the raw /etc/shadow document (JS, no `grep` subprocess). */
	readShadow: () => string | Promise<string>;
	/** Emit the completed SSH status to clients. */
	broadcast: (status: SshStatus) => void;
};

const defaultSshStatusDeps: SshStatusDeps = {
	systemctlIsActive: () => execFileP("systemctl", ["is-active", "ssh"]),
	readShadow: () => Bun.file("/etc/shadow").text(),
	broadcast: (status) => broadcastMsg("status", { ssh: status }),
};

/** True only when `systemctl is-active ssh` printed exactly `active`. */
export function parseSystemctlIsActive(stdout: string): boolean {
	return stdout.trim() === "active";
}

/** Resolve whether the ssh service is active, swallowing the non-zero exit. */
async function probeSshActive(
	systemctlIsActive: SshStatusDeps["systemctlIsActive"],
): Promise<boolean> {
	try {
		const { stdout } = await systemctlIsActive();
		return parseSystemctlIsActive(stdout);
	} catch (err) {
		// `is-active` exits non-zero for inactive/failed/unknown; the unit is
		// simply not active. Treat ANY failure as not-active (never "missing").
		const stdout = (err as { stdout?: string } | null)?.stdout ?? "";
		return parseSystemctlIsActive(stdout);
	}
}

/** Read + parse the user's crypt hash from /etc/shadow, in JS. */
async function probeSshUserHash(
	readShadow: SshStatusDeps["readShadow"],
	user: string,
): Promise<string | undefined> {
	let shadow: string;
	try {
		shadow = await readShadow();
	} catch (err) {
		logger.error(`Error reading /etc/shadow for ${user}: ${err}`);
		return undefined;
	}
	const hash = parseShadowHash(shadow, user);
	if (hash === undefined) {
		logger.error(`No /etc/shadow entry found for ${user}`);
	}
	return hash;
}

/**
 * Probe the SSH service + user password state and broadcast the result.
 *
 * Both probes run concurrently via `Promise.all`; the status object is built
 * once both have settled, and is broadcast EXACTLY ONCE (only when the complete
 * status actually changed). No shared-mutable-object callback race, and the
 * systemctl-error path yields `active: false` rather than dropping the update.
 *
 * Returns the current cached status (same wire shape as before) for callers
 * that want an immediate value.
 */
export async function getSshStatus(
	deps: Partial<SshStatusDeps> = {},
): Promise<SshStatus | undefined> {
	const { systemctlIsActive, readShadow, broadcast } = {
		...defaultSshStatusDeps,
		...deps,
	};

	const ssh_user = setup.ssh_user;
	if (!ssh_user) return sshStatus ?? undefined;
	if (!ID_RE.test(ssh_user) || ssh_user.startsWith("-")) {
		throw new Error("invalid ssh_user");
	}

	const [active, hash] = await Promise.all([
		probeSshActive(systemctlIsActive),
		probeSshUserHash(readShadow, ssh_user),
	]);

	const status: SshStatus = {
		user: ssh_user,
		active,
		...(hash !== undefined ? { user_pass: hash !== sshPasswordHash } : {}),
	};

	// Broadcast exactly once, and only when the complete status changed.
	if (status.active !== undefined && status.user_pass !== undefined) {
		if (
			!sshStatus ||
			status.user !== sshStatus.user ||
			status.active !== sshStatus.active ||
			status.user_pass !== sshStatus.user_pass
		) {
			sshStatus = status;
			broadcast(status);
		}
	}

	return sshStatus ?? undefined;
}

/**
 * Synchronous accessor for the last-known SSH status. The status-message
 * builders embed this in their response immediately and trigger a background
 * `getSshStatus()` refresh (which broadcasts only if something changed) —
 * preserving the original "return cache now, re-probe in the background"
 * behaviour without making the whole status pipeline async.
 */
export function getCachedSshStatus(): SshStatus | undefined {
	return sshStatus ?? undefined;
}

// systemctl ssh control seam (T8): default toggles the real ssh unit; tests spy
// it to assert it fired (prod) or never fired (dev mock).
type SshServiceRunner = (action: "start" | "stop") => Promise<void>;

const defaultSshServiceRunner: SshServiceRunner = async (action) => {
	await execFileP("systemctl", [action, "ssh"]);
};

let sshServiceRunner: SshServiceRunner = defaultSshServiceRunner;

export function setSshServiceRunner(runner: SshServiceRunner): void {
	sshServiceRunner = runner;
}

export function resetSshServiceRunner(): void {
	sshServiceRunner = defaultSshServiceRunner;
}

// Dev-mock SSH active flag, flipped by startStopSsh under shouldUseMocks()
// without spawning systemctl. resetMockSshState() clears it for test isolation.
let mockSshActive = false;

export function resetMockSshState(): void {
	mockSshActive = false;
	sshStatus = null;
}

export async function startStopSsh(
	conn: WebSocket,
	cmd: "start_ssh" | "stop_ssh",
	statusDeps: Partial<SshStatusDeps> = {},
) {
	if (!setup.ssh_user) return;

	const action = cmd === "start_ssh" ? "start" : "stop";

	// Dev/mock seam: flip the SSH active state and broadcast it without spawning
	// systemctl (or resetting a real password), so the toggle works on a dev box.
	if (shouldUseMocks()) {
		mockSshActive = action === "start";
		const status: SshStatus = {
			user: setup.ssh_user,
			active: mockSshActive,
			user_pass: getConfig().ssh_pass !== undefined,
		};
		sshStatus = status;
		broadcastMsg("status", { ssh: status });
		return;
	}

	if (action === "start" && getConfig().ssh_pass === undefined) {
		await resetSshPassword(conn);
	}

	try {
		await sshServiceRunner(action);
	} catch (err) {
		logger.error(
			`Error running systemctl ${action} ssh: ${describeCliError(err)}`,
		);
	}
	await getSshStatus(statusDeps);
}

export async function resetSshPassword(conn: WebSocket) {
	const ssh_user = setup.ssh_user;
	if (!ssh_user) return;
	if (!ID_RE.test(ssh_user) || ssh_user.startsWith("-")) {
		throw new Error("invalid ssh_user");
	}

	const password = randomBase64(24).replace(/[+/=]/g, "").substring(0, 20);

	try {
		// `passwd` reads the new password twice from stdin. The secret is fed via
		// stdin ONLY — never on argv, never through a shell string.
		await runWithStdin("passwd", [ssh_user], `${password}\n${password}\n`);
	} catch (err) {
		logger.error(`Failed to reset the SSH password for ${ssh_user}: ${err}`);
		notificationSend(
			conn,
			"ssh_pass_reset",
			"error",
			`Failed to reset the SSH password for ${ssh_user}`,
			10,
		);
		return;
	}

	const config = getConfig();
	config.ssh_pass = password;
	sshPasswordHash = await probeSshUserHash(
		() => Bun.file("/etc/shadow").text(),
		ssh_user,
	);
	saveConfig();
	broadcastMsg("config", config);
	await getSshStatus();
}
