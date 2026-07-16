/*
 * ssh-password-sync.test.ts — boot-time SSH password reconciliation.
 *
 * `ensureSshPasswordSynced()` re-applies the /data-persisted `ssh_pass` to the
 * rootfs-local /etc/shadow after an A/B OTA slot swap (the swap keeps config.json
 * but bakes a fresh, non-matching shadow entry, silently locking the operator
 * out). It mirrors ceralive-ssh-firstboot.sh's host-key restore: compare the
 * persisted hash against the live one and RE-APPLY (never regenerate) the existing
 * password on a mismatch.
 *
 * Like update-ssh-mock-seams.test.ts, every OS effect (the /etc/shadow read and
 * the `passwd` spawn) is injected through the SshPasswordSyncDeps seam, so the
 * suite asserts on whether `passwd` FIRED and with what stdin — never spawning
 * passwd or reading the real shadow file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initMockService, shouldUseMocks } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import { setup } from "../modules/setup.ts";
import {
	ensureSshPasswordSynced,
	getSshPasswordHash,
	type SshPasswordSyncDeps,
	setSshPasswordHash,
} from "../modules/system/ssh.ts";

// A well-formed /etc/shadow document carrying `hash` as `user`'s crypt field.
function shadowLine(user: string, hash: string): string {
	return `root:!:19000:0:99999:7:::\n${user}:${hash}:19000:0:99999:7:::\n`;
}

// Capture every passwd apply as a {user, password} record so a test can prove
// WHICH plaintext was applied (never a freshly-generated one).
function captureApply(
	calls: Array<{ user: string; password: string }>,
): SshPasswordSyncDeps["applyPassword"] {
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

/** Enter production (real) mode so the sync path actually runs. */
function enterProd(): void {
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	delete process.env.CERALIVE_DEVICE_TYPE;
}

describe("ensureSshPasswordSynced — same-slot boot (hashes match)", () => {
	test("(prod) makes NO passwd call when the OS already matches", async () => {
		enterProd();
		setup.ssh_user = "produser";
		getConfig().ssh_pass = "persisted-secret";
		setSshPasswordHash("$6$abc$hashvalue");
		expect(shouldUseMocks()).toBe(false);

		const calls: Array<{ user: string; password: string }> = [];
		await ensureSshPasswordSynced({
			readShadow: () => shadowLine("produser", "$6$abc$hashvalue"),
			applyPassword: captureApply(calls),
		});

		// Common case: same slot, live shadow hash == cached persisted hash → no-op.
		expect(calls).toHaveLength(0);
	});
});

describe("ensureSshPasswordSynced — fresh OTA slot (hashes differ)", () => {
	test("(prod) re-applies the EXISTING persisted password, never a new one", async () => {
		enterProd();
		setup.ssh_user = "produser";
		getConfig().ssh_pass = "persisted-secret";
		// Cached hash from config.json's ssh_pass_hash (the slot where reset ran)...
		setSshPasswordHash("$6$old$persistedhash");
		expect(shouldUseMocks()).toBe(false);

		const calls: Array<{ user: string; password: string }> = [];
		// ...while THIS freshly-activated slot's shadow still holds the build-time
		// baked hash before the apply, and the re-applied hash after.
		let applied = false;
		await ensureSshPasswordSynced({
			readShadow: () =>
				shadowLine(
					"produser",
					applied ? "$6$new$reappliedhash" : "$6$baked$buildhash",
				),
			applyPassword: async (user, password) => {
				calls.push({ user, password });
				applied = true;
			},
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.user).toBe("produser");
		// CRITICAL: the EXISTING persisted plaintext — proving no random password
		// was generated on the sync path.
		expect(calls[0]?.password).toBe("persisted-secret");
		// The cache is re-probed to the post-apply OS hash (consistent with state).
		expect(getSshPasswordHash()).toBe("$6$new$reappliedhash");
	});
});

describe("ensureSshPasswordSynced — nothing to sync", () => {
	test("(prod) no-op (no shadow read, no passwd) when ssh_pass is unset", async () => {
		enterProd();
		setup.ssh_user = "produser";
		getConfig().ssh_pass = undefined;
		setSshPasswordHash("$6$abc$hashvalue");
		expect(shouldUseMocks()).toBe(false);

		const calls: Array<{ user: string; password: string }> = [];
		let shadowReads = 0;
		await ensureSshPasswordSynced({
			readShadow: () => {
				shadowReads++;
				return shadowLine("produser", "$6$def$otherhash");
			},
			applyPassword: captureApply(calls),
		});

		// Bails before comparing — matches the "generate on first startStopSsh"
		// contract for a genuinely fresh device that never had SSH reset.
		expect(shadowReads).toBe(0);
		expect(calls).toHaveLength(0);
	});
});

describe("ensureSshPasswordSynced — boot-safety (never propagates)", () => {
	test("(prod) a passwd failure is swallowed, not thrown", async () => {
		enterProd();
		setup.ssh_user = "produser";
		getConfig().ssh_pass = "persisted-secret";
		setSshPasswordHash("$6$old$persistedhash");

		await expect(
			ensureSshPasswordSynced({
				readShadow: () => shadowLine("produser", "$6$baked$buildhash"),
				applyPassword: async () => {
					throw new Error("passwd exited with code 1");
				},
			}),
		).resolves.toBeUndefined();
	});

	test("(prod) a shadow-read failure is swallowed, not thrown", async () => {
		enterProd();
		setup.ssh_user = "produser";
		getConfig().ssh_pass = "persisted-secret";
		setSshPasswordHash("$6$old$persistedhash");

		await expect(
			ensureSshPasswordSynced({
				readShadow: () => {
					throw new Error("EACCES: /etc/shadow");
				},
				applyPassword: captureApply([]),
			}),
		).resolves.toBeUndefined();
	});
});

describe("ensureSshPasswordSynced — dev mock seam", () => {
	test("(dev) no shadow read and no passwd apply under mocks", async () => {
		process.env.NODE_ENV = "development";
		delete process.env.MOCK_MODE;
		delete process.env.CERALIVE_DEVICE_TYPE;
		initMockService("multi-modem-wifi");
		setup.ssh_user = "devuser";
		getConfig().ssh_pass = "persisted-secret";
		setSshPasswordHash("$6$old$persistedhash");
		expect(shouldUseMocks()).toBe(true);

		const calls: Array<{ user: string; password: string }> = [];
		let shadowReads = 0;
		await ensureSshPasswordSynced({
			readShadow: () => {
				shadowReads++;
				return shadowLine("devuser", "$6$baked$buildhash");
			},
			applyPassword: captureApply(calls),
		});

		expect(shadowReads).toBe(0);
		expect(calls).toHaveLength(0);
	});
});
