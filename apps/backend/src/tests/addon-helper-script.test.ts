/*
 * End-to-end security tests for the privileged `ceralive-addon-helper` bash
 * script (T27). These drive the REAL script in a hermetic temp sandbox — real
 * jq / gpg / gpgv / sha256sum, stubbed systemctl + systemd-sysext — without root
 * and without touching the host.
 *
 * The properties under test are the G-trust invariants:
 *  - enable/disable/status/refresh work for a baked, validly-signed add-on;
 *  - an id with no baked descriptor is refused (allowlist source = baked only);
 *  - a tampered .raw is refused (sha256 re-verify against the baked descriptor);
 *  - a sysext-INJECTED descriptor cannot bypass the keyring root-of-trust: even
 *    with a matching sha256, an artifact signed by a NON-baked key fails gpgv;
 *  - a malformed / traversal id is refused before any filesystem access.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELPER = join(import.meta.dir, "..", "..", "ceralive-addon-helper");

// The script needs these real tools; skip the suite cleanly where unavailable
// (e.g. a minimal CI image) rather than reporting a false failure.
const HAVE_TOOLS = ["bash", "jq", "gpg", "gpgv", "sha256sum"].every(
	(t) => Bun.which(t) !== null,
);

let ROOT = "";
let LEGIT_HOME = "";
let ATTACKER_HOME = "";
let KEYRING = "";

function sh(
	cmd: string[],
	opts: { env?: Record<string, string> } = {},
): { code: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync(cmd, {
		env: opts.env ? { ...process.env, ...opts.env } : process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function gpgGenKey(home: string, name: string): void {
	mkdirSync(home, { recursive: true });
	chmodSync(home, 0o700);
	const params = join(home, "params");
	writeFileSync(
		params,
		`%no-protection\nKey-Type: RSA\nKey-Length: 2048\nKey-Usage: sign\nName-Real: ${name}\nExpire-Date: 0\n%commit\n`,
	);
	const r = sh(["gpg", "--homedir", home, "--batch", "--gen-key", params]);
	if (r.code !== 0) throw new Error(`gpg gen-key failed: ${r.stderr}`);
}

function gpgExportPub(home: string, out: string): void {
	const proc = Bun.spawnSync(["gpg", "--homedir", home, "--export"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) {
		throw new Error(`gpg export failed: ${proc.stderr.toString()}`);
	}
	writeFileSync(out, proc.stdout);
}

function gpgSign(home: string, raw: string, sig: string): void {
	const r = sh([
		"gpg",
		"--homedir",
		home,
		"--batch",
		"--yes",
		"--detach-sign",
		"--output",
		sig,
		raw,
	]);
	if (r.code !== 0) throw new Error(`gpg sign failed: ${r.stderr}`);
}

function sha256(file: string): string {
	const proc = Bun.spawnSync(["sha256sum", file], { stdout: "pipe" });
	return proc.stdout.toString().split(/\s+/)[0] ?? "";
}

type Descriptor = {
	id: string;
	sha256: string;
	units?: { unmask?: string[]; enable?: string[]; start?: string[] };
};

function writeDescriptor(path: string, d: Descriptor): void {
	const doc = {
		id: d.id,
		name: `Add-on ${d.id}`,
		version: "1.0.0",
		category: "debug",
		payload: { type: "sysext" },
		sysextLevel: "1",
		versionId: "12",
		artifact: {
			urlTemplate: `https://apt.ceralive.tv/addons/${d.id}/{os_version}/${d.id}.raw`,
			sha256: d.sha256,
			gpgSigRef: `https://apt.ceralive.tv/addons/${d.id}/{os_version}/${d.id}.raw.sig`,
			sizeDownload: 1024,
			sizeInstalled: 4096,
		},
		provides: [`/usr/bin/${d.id}`],
		units: d.units ?? {},
	};
	writeFileSync(path, JSON.stringify(doc, null, 2));
}

type Sandbox = {
	dir: string;
	env: Record<string, string>;
	registry: string;
	cache: string;
	ext: string;
	callsLog: string;
};

/** A fresh, fully wired sandbox with one baked, validly-signed `debug-toolset`. */
function mkSandbox(): Sandbox {
	const dir = mkdtempSync(join(ROOT, "sb-"));
	const registry = join(dir, "registry");
	const cache = join(dir, "cache");
	const ext = join(dir, "extensions");
	const bin = join(dir, "bin");
	for (const d of [registry, cache, ext, bin])
		mkdirSync(d, { recursive: true });

	const callsLog = join(dir, "calls.log");
	for (const [name, tag] of [
		["systemctl", "systemctl"],
		["systemd-sysext", "sysext"],
	]) {
		const stub = join(bin, name);
		writeFileSync(
			stub,
			`#!/usr/bin/env bash\nprintf '${tag} %s\\n' "$*" >> ${JSON.stringify(callsLog)}\nexit 0\n`,
		);
		chmodSync(stub, 0o755);
	}

	// A baked, validly-signed add-on with units to exercise the lifecycle.
	const raw = join(cache, "debug-toolset.raw");
	writeFileSync(raw, "SYSEXT-RAW-debug-toolset-v1");
	gpgSign(LEGIT_HOME, raw, `${raw}.sig`);
	writeDescriptor(join(registry, "debug-toolset.json"), {
		id: "debug-toolset",
		sha256: sha256(raw),
		units: {
			unmask: ["debug-toolset.service"],
			enable: ["debug-toolset.service"],
			start: ["debug-toolset.service"],
		},
	});

	const env: Record<string, string> = {
		CERALIVE_ADDON_REGISTRY_DIR: registry,
		CERALIVE_ADDON_KEYRING: KEYRING,
		CERALIVE_ADDON_STAGE_DIR: ext,
		CERALIVE_ADDON_EXT_DIR: ext,
		CERALIVE_ADDON_CACHE_DIR: cache,
		CERALIVE_SYSTEMCTL: join(bin, "systemctl"),
		CERALIVE_SYSEXT: join(bin, "systemd-sysext"),
	};
	return { dir, env, registry, cache, ext, callsLog };
}

function helper(
	sb: Sandbox,
	args: string[],
): { code: number; stdout: string; stderr: string } {
	return sh([HELPER, ...args], { env: sb.env });
}

beforeAll(() => {
	if (!HAVE_TOOLS) return;
	ROOT = mkdtempSync(join(tmpdir(), "addon-helper-"));
	LEGIT_HOME = join(ROOT, "gnupg-legit");
	ATTACKER_HOME = join(ROOT, "gnupg-attacker");
	KEYRING = join(ROOT, "addon-keyring.gpg");
	gpgGenKey(LEGIT_HOME, "CeraLive Add-on Signing (test)");
	gpgGenKey(ATTACKER_HOME, "Attacker (test)");
	// The baked keyring holds ONLY the legitimate public key.
	gpgExportPub(LEGIT_HOME, KEYRING);
});

afterAll(() => {
	if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

/**
 * HAVE_TOOLS gate: These test suites require the ceralive-addon-helper bash
 * script and its dependencies (bash, jq, gpg, gpgv, sha256sum) to be available
 * on the system. The gate checks for all required tools at the top of the file
 * and skips the entire suite cleanly if any are missing (e.g. in minimal CI
 * images) rather than reporting false failures.
 *
 * To install the required tools on a Debian/Ubuntu system:
 *   sudo apt-get install bash jq gnupg coreutils
 *
 * The ceralive-addon-helper script itself must be present at the path resolved
 * by `import.meta.dir` (see line 28).
 */
describe.skipIf(!HAVE_TOOLS)("ceralive-addon-helper — happy path", () => {
	it("enable verifies + activates a baked, validly-signed add-on", async () => {
		const sb = mkSandbox();
		const r = helper(sb, ["enable", "debug-toolset"]);

		expect(r.code).toBe(0);
		const out = JSON.parse(r.stdout) as { ok: boolean; action: string };
		expect(out.ok).toBe(true);
		expect(out.action).toBe("enable");

		// Staged into the sysext scan dir.
		expect(existsSync(join(sb.ext, "debug-toolset.raw"))).toBe(true);

		// Filesystem merge, THEN unit lifecycle (unmask -> enable -> start).
		const log = await Bun.file(sb.callsLog).text();
		expect(log).toContain("sysext refresh");
		expect(log).toContain("systemctl unmask debug-toolset.service");
		expect(log).toContain("systemctl enable debug-toolset.service");
		expect(log).toContain("systemctl start debug-toolset.service");
	});

	it("status emits JSON with the baked registry + installed flag", async () => {
		const sb = mkSandbox();

		// Before enable: present in registry, not installed.
		const before = JSON.parse(helper(sb, ["status"]).stdout) as {
			ok: boolean;
			addons: Array<{ id: string; installed: boolean; units: unknown }>;
		};
		expect(before.ok).toBe(true);
		const a0 = before.addons.find((a) => a.id === "debug-toolset");
		expect(a0?.installed).toBe(false);

		// After enable: installed flips true, units surfaced from the descriptor.
		expect(helper(sb, ["enable", "debug-toolset"]).code).toBe(0);
		const after = JSON.parse(helper(sb, ["status"]).stdout) as {
			addons: Array<{
				id: string;
				installed: boolean;
				units: { start?: string[] };
			}>;
		};
		const a1 = after.addons.find((a) => a.id === "debug-toolset");
		expect(a1?.installed).toBe(true);
		expect(a1?.units.start).toEqual(["debug-toolset.service"]);
	});

	it("disable reverses enable: stop/disable/mask, removes .raw, refresh", async () => {
		const sb = mkSandbox();
		expect(helper(sb, ["enable", "debug-toolset"]).code).toBe(0);

		const r = helper(sb, ["disable", "debug-toolset"]);
		expect(r.code).toBe(0);
		expect((JSON.parse(r.stdout) as { action: string }).action).toBe("disable");

		expect(existsSync(join(sb.ext, "debug-toolset.raw"))).toBe(false);
		const log = await Bun.file(sb.callsLog).text();
		expect(log).toContain("systemctl stop debug-toolset.service");
		expect(log).toContain("systemctl disable debug-toolset.service");
		expect(log).toContain("systemctl mask debug-toolset.service");
	});

	it("refresh runs systemd-sysext refresh only", async () => {
		const sb = mkSandbox();
		const r = helper(sb, ["refresh"]);
		expect(r.code).toBe(0);
		expect((JSON.parse(r.stdout) as { action: string }).action).toBe("refresh");
		expect((await Bun.file(sb.callsLog).text()).trim()).toBe("sysext refresh");
	});
});

/**
 * HAVE_TOOLS gate: See the comment above the first describe.skipIf block for
 * details on the gate and how to install required tools.
 */
describe.skipIf(!HAVE_TOOLS)("ceralive-addon-helper — G-trust refusals", () => {
	it("refuses an id with no baked descriptor (allowlist = baked registry only)", () => {
		const sb = mkSandbox();
		const r = helper(sb, ["enable", "ghost-addon"]);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toMatch(/not in baked registry/);
		// Nothing was staged.
		expect(existsSync(join(sb.ext, "ghost-addon.raw"))).toBe(false);
	});

	it("refuses a tampered artifact (sha256 no longer matches the baked descriptor)", () => {
		const sb = mkSandbox();
		// Tamper AFTER signing + hashing: the descriptor's sha256 is now stale.
		writeFileSync(join(sb.cache, "debug-toolset.raw"), "TAMPERED-PAYLOAD");

		const r = helper(sb, ["enable", "debug-toolset"]);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toMatch(/sha256 mismatch/);
		expect(existsSync(join(sb.ext, "debug-toolset.raw"))).toBe(false);
	});

	it("refuses a sysext-injected descriptor: a non-baked key cannot pass gpgv", () => {
		const sb = mkSandbox();
		// Simulate an attacker who shadows a descriptor into the registry (as a
		// merged sysext overlaying /usr could) AND supplies a matching-sha256
		// artifact — but signs it with a key NOT in the baked keyring.
		const evilRaw = join(sb.cache, "evil-addon.raw");
		writeFileSync(evilRaw, "EVIL-PAYLOAD");
		gpgSign(ATTACKER_HOME, evilRaw, `${evilRaw}.sig`);
		writeDescriptor(join(sb.registry, "evil-addon.json"), {
			id: "evil-addon",
			sha256: sha256(evilRaw), // sha256 deliberately CORRECT — isolates gpg gate
		});

		const r = helper(sb, ["enable", "evil-addon"]);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toMatch(/GPG verify failed/);
		expect(existsSync(join(sb.ext, "evil-addon.raw"))).toBe(false);
	});

	it("refuses when the cached artifact is missing", () => {
		const sb = mkSandbox();
		rmSync(join(sb.cache, "debug-toolset.raw"));
		const r = helper(sb, ["enable", "debug-toolset"]);
		expect(r.code).not.toBe(0);
		expect(r.stderr).toMatch(/artifact not present/);
	});

	it("rejects a traversal / malformed id before any filesystem access", () => {
		const sb = mkSandbox();
		for (const bad of ["../../etc/passwd", "Debug", "a/b", "-rf"]) {
			const r = helper(sb, ["enable", bad]);
			expect(r.code).not.toBe(0);
			expect(r.stderr).toMatch(/invalid add-on id/);
		}
	});
});
