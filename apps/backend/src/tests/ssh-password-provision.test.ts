/*
 * ssh-password-provision.test.ts — boot-time initial SSH password generation.
 *
 * `ensureSshPasswordProvisioned()` mints an initial `ssh_pass` on a device that
 * has never had one (SSH is enabled-by-default at the OS level, but CeraUI only
 * ever generated a password on an explicit operator action, so a fresh device's
 * account was unreachable). It mints through the SAME credential path as the
 * operator "Reset" RPC, and is a strict no-op when a password is ALREADY
 * persisted — that stays ensureSshPasswordSynced's restore-only job.
 *
 * Like ssh-password-sync.test.ts, every OS effect (the /etc/shadow read, the
 * `passwd` spawn, the status refresh) is injected through the
 * SshPasswordProvisionDeps seam, so the suite asserts WHETHER a password
 * materialized and that it was applied stdin-only — never spawning passwd or
 * reading the real shadow file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initMockService, shouldUseMocks } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import {
	ensureSshPasswordProvisioned,
	getSshPasswordHash,
	type SshPasswordProvisionDeps,
	setSshPasswordHash,
} from "../modules/system/ssh.ts";

function shadowLine(user: string, hash: string): string {
	return `root:!:19000:0:99999:7:::\n${user}:${hash}:19000:0:99999:7:::\n`;
}

function captureApply(
	calls: Array<{ user: string; password: string }>,
): SshPasswordProvisionDeps["applyPassword"] {
	return async (user, password) => {
		calls.push({ user, password });
	};
}

let savedNodeEnv: string | undefined;
let savedMockMode: string | undefined;
let savedDeviceType: string | undefined;
let savedSshUser: string | undefined;
let savedSshPass: string | undefined;
let savedSshPasswordHash: string | undefined;

beforeEach(() => {
	savedNodeEnv = process.env.NODE_ENV;
	savedMockMode = process.env.MOCK_MODE;
	savedDeviceType = process.env.CERALIVE_DEVICE_TYPE;
	savedSshUser = setup.ssh_user;
	savedSshPass = getConfig().ssh_pass;
	savedSshPasswordHash = getSshPasswordHash();
});

afterEach(() => {
	const restore = (key: string, value: string | undefined) => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	restore("NODE_ENV", savedNodeEnv);
	restore("MOCK_MODE", savedMockMode);
	restore("CERALIVE_DEVICE_TYPE", savedDeviceType);
	setup.ssh_user = savedSshUser;
	getConfig().ssh_pass = savedSshPass;
	setSshPasswordHash(savedSshPasswordHash);
});

function enterProd(): void {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	delete process.env.CERALIVE_DEVICE_TYPE;
}

describe("ensureSshPasswordProvisioned — no password persisted yet", () => {
	test("(prod) mints, applies stdin-only, and persists a fresh password", async () => {
		enterProd();
		setup.ssh_user = "produser";
		getConfig().ssh_pass = undefined;
		setSshPasswordHash(undefined);
		expect(shouldUseMocks()).toBe(false);

		const calls: Array<{ user: string; password: string }> = [];
		let persisted = 0;
		let statusRefreshed = 0;
		await ensureSshPasswordProvisioned({
			readShadow: () => shadowLine("produser", "$6$new$freshhash"),
			applyPassword: captureApply(calls),
			persist: () => {
				persisted++;
			},
			refreshStatus: async () => {
				statusRefreshed++;
			},
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.user).toBe("produser");
		const applied = calls[0]?.password ?? "";
		expect(applied).toMatch(/^[A-Za-z0-9]{20}$/);
		expect(getConfig().ssh_pass).toBe(applied);
		expect(getSshPasswordHash()).toBe("$6$new$freshhash");
		expect(persisted).toBe(1);
		expect(statusRefreshed).toBe(1);
	});
});

describe("ensureSshPasswordProvisioned — password already persisted", () => {
	test("(prod) never regenerates an existing credential", async () => {
		enterProd();
		setup.ssh_user = "produser";
		getConfig().ssh_pass = "already-there";
		setSshPasswordHash("$6$old$existinghash");
		expect(shouldUseMocks()).toBe(false);

		const calls: Array<{ user: string; password: string }> = [];
		let shadowReads = 0;
		await ensureSshPasswordProvisioned({
			readShadow: () => {
				shadowReads++;
				return shadowLine("produser", "$6$old$existinghash");
			},
			applyPassword: captureApply(calls),
			persist: () => {},
			refreshStatus: async () => {},
		});

		expect(calls).toHaveLength(0);
		expect(shadowReads).toBe(0);
		expect(getConfig().ssh_pass).toBe("already-there");
		expect(getSshPasswordHash()).toBe("$6$old$existinghash");
	});
});

describe("ensureSshPasswordProvisioned — boot-safety (never propagates)", () => {
	test("(prod) a passwd failure is swallowed, config left unset", async () => {
		enterProd();
		setup.ssh_user = "produser";
		getConfig().ssh_pass = undefined;
		setSshPasswordHash(undefined);

		await expect(
			ensureSshPasswordProvisioned({
				readShadow: () => shadowLine("produser", "$6$x$y"),
				applyPassword: async () => {
					throw new Error("passwd exited with code 1");
				},
				persist: () => {},
				refreshStatus: async () => {},
			}),
		).resolves.toBeUndefined();

		expect(getConfig().ssh_pass).toBeUndefined();
	});
});

describe("ensureSshPasswordProvisioned — dev mock seam", () => {
	test("(dev) no shadow read and no passwd apply under mocks", async () => {
		process.env.NODE_ENV = "development";
		delete process.env.MOCK_MODE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		initMockService("multi-modem-wifi");
		setup.ssh_user = "devuser";
		getConfig().ssh_pass = undefined;
		setSshPasswordHash(undefined);
		expect(shouldUseMocks()).toBe(true);

		const calls: Array<{ user: string; password: string }> = [];
		let shadowReads = 0;
		await ensureSshPasswordProvisioned({
			readShadow: () => {
				shadowReads++;
				return shadowLine("devuser", "$6$x$y");
			},
			applyPassword: captureApply(calls),
			persist: () => {},
			refreshStatus: async () => {},
		});

		expect(shadowReads).toBe(0);
		expect(calls).toHaveLength(0);
		expect(getConfig().ssh_pass).toBeUndefined();
	});
});
