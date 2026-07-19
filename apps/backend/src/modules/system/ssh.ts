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

import { randomBase64 } from "../../helpers/crypto.ts";
import { execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { runWithStdin } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getConfig, saveConfig } from "../config.ts";
import { setup } from "../setup.ts";
import type { MessageSocket } from "../ui/message-socket.ts";
import {
	notificationBroadcast,
	notificationSend,
} from "../ui/notifications.ts";
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
const DEFAULT_SSH_USER = "ceralive";

let sshStatus: SshStatus | null = null;
let sshPasswordHash: string | undefined;

export function setSshPasswordHash(hash: string | undefined) {
	sshPasswordHash = hash;
}

export function getSshPasswordHash() {
	return sshPasswordHash;
}

function resolveSshUser(): string {
	const sshUser = setup.ssh_user ?? DEFAULT_SSH_USER;
	if (!ID_RE.test(sshUser) || sshUser.startsWith("-")) {
		throw new Error("invalid ssh_user");
	}
	return sshUser;
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

	const ssh_user = resolveSshUser();

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
	if (
		!sshStatus ||
		status.user !== sshStatus.user ||
		status.active !== sshStatus.active ||
		status.user_pass !== sshStatus.user_pass
	) {
		sshStatus = status;
		broadcast(status);
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
	conn: MessageSocket,
	cmd: "start_ssh" | "stop_ssh",
	statusDeps: Partial<SshStatusDeps> = {},
) {
	const ssh_user = resolveSshUser();

	const action = cmd === "start_ssh" ? "start" : "stop";

	// Dev/mock seam: flip the SSH active state and broadcast it without spawning
	// systemctl (or resetting a real password), so the toggle works on a dev box.
	if (shouldUseMocks()) {
		mockSshActive = action === "start";
		const status: SshStatus = {
			user: ssh_user,
			active: mockSshActive,
			user_pass: getConfig().ssh_pass !== undefined,
		};
		sshStatus = status;
		broadcastMsg("status", { ssh: status });
		return true;
	}

	if (action === "start" && getConfig().ssh_pass === undefined) {
		const password = await resetSshPassword(conn);
		if (password === undefined) return false;
	}

	try {
		await sshServiceRunner(action);
	} catch (err) {
		logger.error(
			`Error running systemctl ${action} ssh: ${describeCliError(err)}`,
		);
		return false;
	}
	const status = await getSshStatus(statusDeps);
	return action === "start"
		? status?.active === true
		: status?.active === false;
}

/**
 * Injectable surface for {@link mintAndApplySshPassword}. Defaults talk to the
 * real OS (stdin-only `passwd`, JS `/etc/shadow` read) and drive a real status
 * refresh; tests inject deterministic stand-ins so the credential-minting path
 * can be exercised without a real `passwd` spawn.
 */
export type SshPasswordProvisionDeps = {
	/** Read the raw /etc/shadow document (JS, no `grep` subprocess). */
	readShadow: () => string | Promise<string>;
	/** Apply `password` to `user`'s OS account via `passwd` (stdin only). */
	applyPassword: (user: string, password: string) => Promise<void>;
	/** Persist the mutated config (defaults to the real `saveConfig`). */
	persist: () => void;
	/** Re-probe + broadcast the SSH status after the credential changed. */
	refreshStatus: () => Promise<void>;
};

const defaultSshPasswordProvisionDeps: SshPasswordProvisionDeps = {
	readShadow: () => Bun.file("/etc/shadow").text(),
	applyPassword: async (user, password) => {
		// `passwd` reads the new password twice from stdin. The secret is fed via
		// stdin ONLY — never on argv, never through a shell string.
		await runWithStdin("passwd", [user], `${password}\n${password}\n`);
	},
	persist: saveConfig,
	refreshStatus: async () => {
		await getSshStatus();
	},
};

/**
 * The single SSH-credential-minting path, shared verbatim by the operator
 * "Reset" RPC ({@link resetSshPassword}) and boot-time provisioning
 * ({@link ensureSshPasswordProvisioned}): generate a random password, apply it
 * stdin-only, persist it, re-probe the hash, broadcast config + status. Throws
 * only on {@link SshPasswordProvisionDeps.applyPassword} failure so callers pick
 * how to surface it (operator notification vs boot broadcast).
 */
async function mintAndApplySshPassword(
	ssh_user: string,
	deps: SshPasswordProvisionDeps = defaultSshPasswordProvisionDeps,
): Promise<string> {
	const password = randomBase64(24).replace(/[+/=]/g, "").substring(0, 20);

	await deps.applyPassword(ssh_user, password);

	const config = getConfig();
	config.ssh_pass = password;
	sshPasswordHash = await probeSshUserHash(deps.readShadow, ssh_user);
	deps.persist();
	broadcastMsg("config", config);
	await deps.refreshStatus();
	return password;
}

export async function resetSshPassword(
	conn: MessageSocket,
): Promise<string | undefined> {
	const ssh_user = resolveSshUser();

	try {
		return await mintAndApplySshPassword(ssh_user);
	} catch (err) {
		logger.error(`Failed to reset the SSH password for ${ssh_user}: ${err}`);
		notificationSend(
			conn,
			"ssh_pass_reset",
			"error",
			`Failed to reset the SSH password for ${ssh_user}`,
			10,
		);
		return undefined;
	}
}

/**
 * Boot-time provisioning of an initial SSH password when the device has never
 * had one. SSH is enabled-by-default at the OS/systemd level (image-baked), but
 * CeraUI only ever minted a password on an explicit operator "Start SSH" /
 * "Reset" click — so a fresh device ran `sshd` with `ssh_pass` permanently
 * `undefined` until a manual reset. When NO `ssh_pass` is persisted this mints
 * one through the SAME {@link mintAndApplySshPassword} path the reset uses.
 *
 * Called UNCONDITIONALLY at boot (independent of the `ssh.service` active/enabled
 * state) so even a production device shipping with SSH disabled-by-default has a
 * ready credential the instant SSH is enabled from the UI. Contract: never throws
 * (BOOT FAIL-SOFT); a clean no-op under `shouldUseMocks()` or when a password is
 * ALREADY persisted — it NEVER regenerates an existing credential (that is
 * {@link ensureSshPasswordSynced}'s restore-only job). The secret is minted,
 * persisted, and broadcast through the existing RPC/config path only, never logged.
 */
export async function ensureSshPasswordProvisioned(
	deps: Partial<SshPasswordProvisionDeps> = {},
): Promise<void> {
	if (shouldUseMocks()) return;

	let ssh_user: string;
	try {
		ssh_user = resolveSshUser();
	} catch (err) {
		logger.error(`Skipping SSH password provisioning: ${err}`);
		return;
	}

	if (getConfig().ssh_pass !== undefined) return;

	try {
		await mintAndApplySshPassword(ssh_user, {
			...defaultSshPasswordProvisionDeps,
			...deps,
		});
		logger.info(`Generated an initial SSH password for ${ssh_user}`);
	} catch (err) {
		logger.error(
			`Failed to provision an initial SSH password for ${ssh_user}: ${err}`,
		);
		notificationBroadcast(
			"ssh_pass_provision",
			"error",
			`Failed to generate the initial SSH password for ${ssh_user}`,
			0,
			true,
		);
	}
}

/**
 * Injectable surface for {@link ensureSshPasswordSynced}. Mirrors the
 * {@link SshStatusDeps} DI pattern so tests drive the sync without a real
 * `/etc/shadow` read or a real `passwd` spawn. `readShadow` is fed to the shared
 * {@link probeSshUserHash}; `applyPassword` runs the same stdin-only `passwd`
 * path {@link resetSshPassword} uses.
 */
export type SshPasswordSyncDeps = {
	/** Read the raw /etc/shadow document (JS, no `grep` subprocess). */
	readShadow: () => string | Promise<string>;
	/** Apply `password` to `user`'s OS account via `passwd` (stdin only). */
	applyPassword: (user: string, password: string) => Promise<void>;
};

const defaultSshPasswordSyncDeps: SshPasswordSyncDeps = {
	readShadow: () => Bun.file("/etc/shadow").text(),
	applyPassword: async (user, password) => {
		// `passwd` reads the new password twice from stdin. The secret is fed via
		// stdin ONLY — never on argv (parity with resetSshPassword).
		await runWithStdin("passwd", [user], `${password}\n${password}\n`);
	},
};

/**
 * Boot-time reconciliation of the persisted SSH password against the live OS.
 *
 * `config.json` (which stores `ssh_pass` + `ssh_pass_hash`) is `/data`-persisted
 * and survives an A/B OTA slot swap, but the OS-level `/etc/shadow` entry is
 * rootfs-local — baked fresh into each image and NOT carried across a slot swap.
 * So after an OTA the fresh slot's shadow holds a build-time password while
 * config.json still remembers the operator's real one, locking the operator out
 * until they manually reset. This mirrors the host-key restore in
 * image-building-pipeline's `ceralive-ssh-firstboot.sh::ensure_host_keys()`:
 * compare the persisted identity against the live one and RE-APPLY (never
 * regenerate) the persisted one on a mismatch.
 *
 * Contract: never throws (BOOT FAIL-SOFT); a clean no-op under mocks, when
 * nothing is persisted yet (`ssh_pass === undefined`), or when the OS already
 * matches (the common same-slot boot). It re-applies the EXISTING persisted
 * password — it NEVER generates a new one and NEVER writes config (the credential
 * is unchanged; only the OS-level shadow entry must catch up).
 */
export async function ensureSshPasswordSynced(
	deps: Partial<SshPasswordSyncDeps> = {},
): Promise<void> {
	// Dev/mock seam: never spawn passwd or read the real /etc/shadow on a dev box
	// (mirrors startStopSsh's shouldUseMocks() gate).
	if (shouldUseMocks()) return;

	let ssh_user: string;
	try {
		ssh_user = resolveSshUser();
	} catch (err) {
		logger.error(`Skipping SSH password sync: ${err}`);
		return;
	}

	// Nothing persisted yet → nothing to sync. Leaves the existing "generate on
	// first startStopSsh when ssh_pass is undefined" contract untouched.
	const password = getConfig().ssh_pass;
	if (password === undefined) return;

	const { readShadow, applyPassword } = {
		...defaultSshPasswordSyncDeps,
		...deps,
	};

	// The live OS hash vs the cached hash loadConfig() set from the persisted
	// ssh_pass_hash. Equal → this slot already matches (the common same-slot
	// boot); a fast, harmless no-op.
	const liveHash = await probeSshUserHash(readShadow, ssh_user);
	if (liveHash === sshPasswordHash) return;

	try {
		// Mismatch (a fresh OTA slot still carrying the build-time password):
		// re-apply the EXISTING persisted password so the operator's credential
		// stays stable across the update. A RESTORE, not a reset — no new random
		// password, no saveConfig().
		await applyPassword(ssh_user, password);
	} catch (err) {
		logger.error(`Failed to sync the SSH password for ${ssh_user}: ${err}`);
		notificationBroadcast(
			"ssh_pass_sync",
			"error",
			`Failed to sync the SSH password for ${ssh_user}`,
			0,
			true,
		);
		return;
	}

	// Re-probe so the cached hash (and the SSH status tile it feeds) reflects the
	// OS we just wrote — the crypt salt on this slot differs from the persisted
	// hash's, so read back the authoritative value rather than assume it.
	sshPasswordHash = await probeSshUserHash(readShadow, ssh_user);
	logger.info(`Re-applied the persisted SSH password for ${ssh_user}`);
}
