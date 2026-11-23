import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import {
	getRecentLogLines,
	isSecretWordKey,
	isSensitiveKey,
	logger,
	logRedact,
	REDACTED,
} from "../helpers/logger.ts";
import {
	getConfig,
	getConfigFilePath,
	loadConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import { setSshPasswordHash } from "../modules/system/ssh.ts";
import { setPasswordHash } from "../rpc/state/password.ts";

// The config.json fields the logger treats as credentials. A new credential
// field must either have a secret-shaped name or be added to the logger's
// rules, and a rule broad enough to hide an ordinary setting fails this test.
const CONFIG_CREDENTIAL_KEYS = [
	"password",
	"password_hash",
	"pairing_secret",
	"remote_key",
	"ssh_pass",
	"ssh_pass_hash",
];

const SSH_PASS = "ssh-pass-value-7f3a";
const SSH_HASH = "$6$saltsalt$sshhashvalue7f3a";
const REMOTE_KEY = "remote-key-value-7f3a";
const CREDENTIAL_CONFIG = {
	password: "ui-password-7f3a",
	password_hash: "$2b$10$uihashvalue7f3a",
	ssh_pass: SSH_PASS,
	ssh_pass_hash: SSH_HASH,
	remote_key: REMOTE_KEY,
	pairing_secret: "pairing-secret-7f3a",
	ssh_persistent: true,
	video_passthrough: "auto",
	autostart: false,
};
const SECRET_VALUES = [
	"ui-password-7f3a",
	"uihashvalue7f3a",
	SSH_PASS,
	"sshhashvalue7f3a",
	REMOTE_KEY,
	"pairing-secret-7f3a",
];

describe("credential key words", () => {
	test.each([
		"ssh_pass",
		"ssh_pass_hash",
		"sshPass",
		"sshPassHash",
		"ssh-pass",
		"SSH_PASS",
		"wifi_pwd",
		"passwd",
		"passcode",
		"wifi_psk",
		"remote_key",
		"remoteKey",
		"private_key",
		"privateKeyPem",
		"stream_key",
		"api_key",
		"ingest_keys",
		"shadow_hash",
		"client_secret",
	])("%s is redacted", (key) => {
		expect(isSecretWordKey(key)).toBe(true);
		expect(isSensitiveKey(key)).toBe(true);
	});

	test.each([
		"video_passthrough",
		"passthrough",
		"bypass",
		"passed",
		"ssh_persistent",
		"keyframe",
		"keyCount",
		"key",
		"stableKey",
		"streamKeyCount",
		"remoteCommitHash",
		"hash",
		"commitHash",
		"modem_shadow",
		"sshd",
	])("%s stays readable", (key) => {
		expect(isSecretWordKey(key)).toBe(false);
	});
});

describe("nested qualifiers", () => {
	test("a key or hash is redacted when its parent key names the material", () => {
		const out = logRedact({
			remote: { key: "nested-remote-9e" },
			ssh: { hash: "nested-ssh-hash-9e", port: 22 },
			video: { key: "keep-9e" },
			items: [{ remote: { keys: ["nested-list-9e"] } }],
		}) as {
			remote: { key: string };
			ssh: { hash: string; port: number };
			video: { key: string };
			items: [{ remote: { keys: unknown } }];
		};
		expect(out.remote.key).toBe(REDACTED);
		expect(out.ssh.hash).toBe(REDACTED);
		expect(out.ssh.port).toBe(22);
		expect(out.video.key).toBe("keep-9e");
		expect(out.items[0].remote.keys).toBe(REDACTED);
		expect(isSecretWordKey("key", "remote")).toBe(true);
		expect(isSecretWordKey("key", "video")).toBe(false);
	});

	test("key and hash count only as the material itself, not inside another word's name", () => {
		const out = logRedact({
			remote: { commitHash: "keep-commit-r3", key_pem: "nested-pem-r3" },
			stream: { keyCount: 3, key: "nested-stream-key-r3" },
			streamKeyCount: 4,
		}) as {
			remote: { commitHash: string; key_pem: string };
			stream: { keyCount: number; key: string };
			streamKeyCount: number;
		};
		expect(out.remote.commitHash).toBe("keep-commit-r3");
		expect(out.remote.key_pem).toBe(REDACTED);
		expect(out.stream.keyCount).toBe(3);
		expect(out.stream.key).toBe(REDACTED);
		expect(out.streamKeyCount).toBe(4);
	});
});

describe("config credentials", () => {
	test("the logger redacts exactly the credential fields of the runtime config", () => {
		const keys = Object.keys(runtimeConfigSchema.shape);
		for (const key of CONFIG_CREDENTIAL_KEYS) expect(keys).toContain(key);
		expect(keys.filter((key) => isSensitiveKey(key)).sort()).toEqual(
			[...CONFIG_CREDENTIAL_KEYS].sort(),
		);
	});

	test("a whole config object logged as metadata keeps no credential value", () => {
		const out = logRedact(CREDENTIAL_CONFIG) as Record<string, unknown>;
		for (const key of CONFIG_CREDENTIAL_KEYS)
			if (key in CREDENTIAL_CONFIG) expect(out[key]).toBe(REDACTED);
		expect(out.ssh_persistent).toBe(true);
		expect(out.video_passthrough).toBe("auto");

		logger.debug("credential fixture", CREDENTIAL_CONFIG);
		logger.debug("nested credential fixture", { config: CREDENTIAL_CONFIG });
		const lines = getRecentLogLines().slice(-2);
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			for (const value of SECRET_VALUES) expect(line).not.toContain(value);
			expect(line).toContain('"ssh_pass":"[REDACTED]"');
			expect(line).toContain('"ssh_pass_hash":"[REDACTED]"');
			expect(line).toContain('"remote_key":"[REDACTED]"');
			expect(line).toContain('"video_passthrough":"auto"');
		}
	});
});

describe("config loaded", () => {
	let tempDir: string;
	let previousPath: string;
	let previousConfig: Record<string, unknown>;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-credentials-"));
		previousPath = getConfigFilePath();
		previousConfig = { ...getConfig() };
	});

	afterEach(() => {
		// loadConfig replaces the module's config object; give later files the
		// contents they had, not this fixture's credentials.
		const loaded = getConfig() as Record<string, unknown>;
		for (const key of Object.keys(loaded)) delete loaded[key];
		Object.assign(loaded, previousConfig);
		setConfigFilePath(previousPath);
		setPasswordHash(undefined);
		setSshPasswordHash(undefined);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("loading config.json logs its key names and no credential", async () => {
		const file = path.join(tempDir, "config.json");
		fs.writeFileSync(file, JSON.stringify(CREDENTIAL_CONFIG), { mode: 0o600 });
		setConfigFilePath(file);

		await loadConfig();

		const line = getRecentLogLines().find((entry) =>
			entry.includes('"msg":"config loaded"'),
		);
		expect(line).toBeDefined();
		for (const value of SECRET_VALUES) expect(line).not.toContain(value);
		const record = JSON.parse(line ?? "{}") as {
			meta?: { keys?: string[] };
		};
		expect(record.meta?.keys).toContain("ssh_pass");
		expect(record.meta?.keys).toContain("ssh_pass_hash");
		expect(Object.keys(record.meta ?? {})).toEqual(["keys"]);
	});
});
