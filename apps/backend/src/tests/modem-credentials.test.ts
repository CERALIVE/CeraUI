/*
 * The server-side router-WebUI credential store.
 *
 * Everything asserted here is a SAFETY property rather than a feature: the
 * secret is filed against the physical unit that owns it, it is readable only by
 * root, it never appears in a wire projection, it never reaches a log, and it is
 * never written into `config.json`. Each of those has a way of degrading
 * silently, so each has its own test and — where absence is the claim — its own
 * non-vacuity control.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	clearRecentLogLines,
	getRecentLogLines,
	isCredentialSensitiveKey,
	logger,
	logRedact,
	REDACTED,
} from "../helpers/logger.ts";
import {
	clearModemCredential,
	initModemCredentials,
	MODEM_CREDENTIALS_DIR,
	MODEM_CREDENTIALS_FILE,
	modemCredentialKey,
	modemCredentialsPath,
	projectModemCredential,
	readModemCredential,
	recordModemCredentialOutcome,
	resetModemCredentialsForTest,
	writeModemCredential,
} from "../modules/modems/modem-credentials.ts";
import {
	type PhysicalObservation,
	resetPhysicalIdentityRegistry,
	resolvePhysicalDevice,
} from "../modules/modems/physical-identity.ts";

/** A password that could never occur by accident in a log line or a payload. */
const PASSWORD = "z9Qv-bench-secret-4417";
const USERNAME = "admin";

/** The board's own ID_PATH shape, from its `udevadm` read of the HiLink slots. */
function idPathFor(busId: string): string {
	return `platform-xhci-hcd.0.auto-usb-0:${busId.replace(/^\d+-/, "")}`;
}

/**
 * The bench HiLink TWINS, verbatim.
 *
 * Two physically distinct dongles publishing ONE factory MAC
 * (`0c:5b:8f:27:9a:64`): systemd derives `enx0c5b8f279a64` for whichever wins
 * the rename and the loser falls back to its kernel default `eth1`. Neither
 * exposes a usable USB serial, so only the PORT separates them — which is
 * exactly the case a MAC-keyed or name-keyed store gets wrong.
 */
const TWIN_A: PhysicalObservation = {
	ifname: "enx0c5b8f279a64",
	idPath: idPathFor("1-1.3.1"),
	vid: "12d1",
	pid: "14dc",
};

const TWIN_B: PhysicalObservation = {
	ifname: "eth1",
	idPath: idPathFor("1-1.3.2"),
	vid: "12d1",
	pid: "14dc",
};

/** A Qualcomm stick that DOES publish a serial — the stronger identity rung. */
const SERIAL_STICK: PhysicalObservation = {
	ifname: "wwan2",
	idPath: idPathFor("1-1.4.3"),
	vid: "05c6",
	pid: "9091",
	serial: "c6125db3",
};

/** A device with neither a serial nor an ID_PATH — the refused `ifname` rung. */
const UNANCHORED: PhysicalObservation = { ifname: "eth7" };

let tempDirs: string[] = [];

function tempStorePath(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "ceralive-modem-creds-"));
	tempDirs.push(dir);
	return path.join(dir, "store", MODEM_CREDENTIALS_FILE);
}

function modeOf(target: string): number {
	return fs.statSync(target).mode & 0o777;
}

beforeEach(() => {
	resetModemCredentialsForTest();
	resetPhysicalIdentityRegistry();
	clearRecentLogLines();
});

afterEach(() => {
	resetModemCredentialsForTest();
	resetPhysicalIdentityRegistry();
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("the key is the PHYSICAL unit — never a name, never an address", () => {
	it("REFUSES an ifname-anchored device rather than filing under a weak key", () => {
		const device = resolvePhysicalDevice(UNANCHORED);
		expect(device.anchor).toBe("ifname");
		expect(modemCredentialKey(device)).toBeUndefined();

		// A refusal costs a re-entry; a name-keyed row would hand the NEXT device
		// in that slot the previous unit's login.
		expect(
			writeModemCredential(device, { username: USERNAME, password: PASSWORD }),
		).toBe(false);
		expect(readModemCredential(device)).toBeUndefined();
		expect(projectModemCredential(device)).toEqual({ configured: false });
	});

	it("keys a serial-bearing device on the stronger rung", () => {
		const device = resolvePhysicalDevice(SERIAL_STICK);
		expect(device.anchor).toBe("usb-serial");
		expect(modemCredentialKey(device)).toBe(device.linkId);
	});

	it("keys a serial-less device on its PORT, not its interface name", () => {
		const device = resolvePhysicalDevice(TWIN_A);
		expect(device.anchor).toBe("id-path");
		expect(modemCredentialKey(device)).toBe(device.linkId);
	});
});

describe("two twins sharing a factory MAC get SEPARATE rows", () => {
	it("stores, reads back and clears each unit independently", async () => {
		await initModemCredentials(tempStorePath());

		const a = resolvePhysicalDevice(TWIN_A);
		const b = resolvePhysicalDevice(TWIN_B);

		// Non-vacuity: the fixture really is the collision case — one shared MAC
		// expressed through the two ifnames systemd produces from it.
		expect(a.ifname).toContain("0c5b8f279a64");
		expect(b.ifname).toBe("eth1");
		expect(modemCredentialKey(a)).not.toBe(modemCredentialKey(b));

		expect(
			writeModemCredential(a, { username: USERNAME, password: PASSWORD }),
		).toBe(true);
		expect(
			writeModemCredential(b, { username: "root", password: "b-side-8821" }),
		).toBe(true);

		expect(readModemCredential(a)?.password).toBe(PASSWORD);
		expect(readModemCredential(b)?.password).toBe("b-side-8821");

		// Clearing one leaves its twin's login untouched.
		expect(clearModemCredential(a)).toBe(true);
		expect(readModemCredential(a)).toBeUndefined();
		expect(readModemCredential(b)?.password).toBe("b-side-8821");
	});

	it("a unit MOVED to another port does not inherit the previous unit's login", async () => {
		await initModemCredentials(tempStorePath());

		const inSlot1 = resolvePhysicalDevice(TWIN_A);
		writeModemCredential(inSlot1, {
			username: USERNAME,
			password: PASSWORD,
		});

		// Same unit, same name, different socket: identity is SAME-PORT stability
		// for a serial-less device, so the credential deliberately does not follow.
		const moved = resolvePhysicalDevice({
			...TWIN_A,
			idPath: idPathFor("1-1.4.4"),
		});
		expect(readModemCredential(moved)).toBeUndefined();
	});
});

describe("the on-disk document", () => {
	it("is written at exactly 0600, inside a directory with no group/other bits", async () => {
		const storePath = tempStorePath();
		await initModemCredentials(storePath);

		const device = resolvePhysicalDevice(SERIAL_STICK);
		writeModemCredential(device, { username: USERNAME, password: PASSWORD });

		expect(fs.existsSync(storePath)).toBe(true);
		expect(modeOf(storePath)).toBe(0o600);
		expect(modeOf(path.dirname(storePath)) & 0o077).toBe(0);
	});

	it("CORRECTS a pre-existing world-readable file on the next write", async () => {
		const storePath = tempStorePath();
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(storePath, JSON.stringify({ version: 1, devices: {} }));
		fs.chmodSync(storePath, 0o666);
		// Non-vacuity: the file really is world-readable before the write.
		expect(modeOf(storePath)).toBe(0o666);

		await initModemCredentials(storePath);
		writeModemCredential(resolvePhysicalDevice(SERIAL_STICK), {
			username: USERNAME,
			password: PASSWORD,
		});

		expect(modeOf(storePath)).toBe(0o600);
	});

	it("round-trips across a simulated restart", async () => {
		const storePath = tempStorePath();
		await initModemCredentials(storePath);

		const device = resolvePhysicalDevice(SERIAL_STICK);
		writeModemCredential(device, {
			username: USERNAME,
			password: PASSWORD,
			lastVerifiedAt: 1_785_169_237_000,
			lastOutcome: "unlocked",
		});

		// Restart: drop every byte of in-memory state, then load from disk alone.
		resetModemCredentialsForTest();
		resetPhysicalIdentityRegistry();
		await initModemCredentials(storePath);

		const afterRestart = resolvePhysicalDevice(SERIAL_STICK);
		expect(readModemCredential(afterRestart)).toEqual({
			username: USERNAME,
			password: PASSWORD,
			lastVerifiedAt: 1_785_169_237_000,
			lastOutcome: "unlocked",
		});
		expect(modeOf(storePath)).toBe(0o600);
	});

	it("leaves no temp file behind", async () => {
		const storePath = tempStorePath();
		await initModemCredentials(storePath);
		writeModemCredential(resolvePhysicalDevice(SERIAL_STICK), {
			username: USERNAME,
			password: PASSWORD,
		});

		const leftovers = fs
			.readdirSync(path.dirname(storePath))
			.filter((name) => name.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("writes NOTHING until the store is initialised", () => {
		const unopened = tempStorePath();
		const previous = process.env.CERALIVE_MODEM_CREDENTIALS_FILE;
		process.env.CERALIVE_MODEM_CREDENTIALS_FILE = unopened;
		try {
			expect(modemCredentialsPath()).toBe(unopened);

			const device = resolvePhysicalDevice(SERIAL_STICK);
			// An uninitialised store is purely in-memory, so a unit test that never
			// opts in cannot drop a secret into the working directory.
			expect(
				writeModemCredential(device, {
					username: USERNAME,
					password: PASSWORD,
				}),
			).toBe(true);
			expect(readModemCredential(device)?.password).toBe(PASSWORD);
			expect(fs.existsSync(unopened)).toBe(false);
		} finally {
			if (previous === undefined) {
				delete process.env.CERALIVE_MODEM_CREDENTIALS_FILE;
			} else {
				process.env.CERALIVE_MODEM_CREDENTIALS_FILE = previous;
			}
		}
	});

	it("pins the device path under /data, which survives an OTA slot swap", () => {
		const previousOverride = process.env.CERALIVE_MODEM_CREDENTIALS_FILE;
		const previousEnv = process.env.NODE_ENV;
		const previousMock = process.env.MOCK_MODE;
		delete process.env.CERALIVE_MODEM_CREDENTIALS_FILE;
		process.env.NODE_ENV = "production";
		delete process.env.MOCK_MODE;
		try {
			expect(modemCredentialsPath()).toBe(
				path.join(MODEM_CREDENTIALS_DIR, MODEM_CREDENTIALS_FILE),
			);
		} finally {
			if (previousOverride !== undefined) {
				process.env.CERALIVE_MODEM_CREDENTIALS_FILE = previousOverride;
			}
			if (previousEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = previousEnv;
			}
			if (previousMock !== undefined) {
				process.env.MOCK_MODE = previousMock;
			}
		}
	});
});

describe("a damaged store degrades, it never throws", () => {
	it("starts empty on unparseable JSON and still accepts a fresh write", async () => {
		const storePath = tempStorePath();
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(storePath, "{ this is not json");

		await expect(initModemCredentials(storePath)).resolves.toBeUndefined();

		const device = resolvePhysicalDevice(SERIAL_STICK);
		expect(readModemCredential(device)).toBeUndefined();
		expect(
			writeModemCredential(device, { username: USERNAME, password: PASSWORD }),
		).toBe(true);
		expect(readModemCredential(device)?.password).toBe(PASSWORD);
		expect(modeOf(storePath)).toBe(0o600);
	});

	it("starts empty on a well-formed document of the wrong shape", async () => {
		const storePath = tempStorePath();
		fs.mkdirSync(path.dirname(storePath), { recursive: true });
		fs.writeFileSync(
			storePath,
			JSON.stringify({ version: 1, devices: { lnk_abc: { username: 7 } } }),
		);

		await expect(initModemCredentials(storePath)).resolves.toBeUndefined();
		expect(readModemCredential(resolvePhysicalDevice(SERIAL_STICK))).toBe(
			undefined,
		);
	});

	it("starts empty when the file is absent", async () => {
		const storePath = tempStorePath();
		await expect(initModemCredentials(storePath)).resolves.toBeUndefined();
		expect(readModemCredential(resolvePhysicalDevice(SERIAL_STICK))).toBe(
			undefined,
		);
	});

	it("a failed persist keeps the in-memory value and logs no secret", async () => {
		// A regular file where the store's DIRECTORY must go: `mkdirSync` rejects,
		// so the write path throws and the module takes its warn branch.
		const dir = mkdtempSync(path.join(tmpdir(), "ceralive-modem-creds-"));
		tempDirs.push(dir);
		const blocker = path.join(dir, "store");
		fs.writeFileSync(blocker, "not a directory");
		await initModemCredentials(path.join(blocker, MODEM_CREDENTIALS_FILE));

		clearRecentLogLines();
		const device = resolvePhysicalDevice(SERIAL_STICK);
		expect(
			writeModemCredential(device, { username: USERNAME, password: PASSWORD }),
		).toBe(true);

		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("failed to persist");
		expect(emitted).not.toContain(PASSWORD);
		// The operator loses persistence, not the device.
		expect(readModemCredential(device)?.password).toBe(PASSWORD);
	});
});

describe("an empty credential is not a credential", () => {
	it("refuses a write with neither a username nor a password", async () => {
		await initModemCredentials(tempStorePath());
		const device = resolvePhysicalDevice(SERIAL_STICK);
		expect(writeModemCredential(device, { username: "", password: "" })).toBe(
			false,
		);
		expect(projectModemCredential(device)).toEqual({ configured: false });
	});

	it("accepts a password-only login, which is what these WebUIs actually use", async () => {
		await initModemCredentials(tempStorePath());
		const device = resolvePhysicalDevice(SERIAL_STICK);
		expect(
			writeModemCredential(device, { username: "", password: PASSWORD }),
		).toBe(true);
		expect(readModemCredential(device)?.password).toBe(PASSWORD);
	});
});

describe("the outcome moves without re-handling the password", () => {
	it("records a lock state and a verification stamp against a stored login", async () => {
		await initModemCredentials(tempStorePath());
		const device = resolvePhysicalDevice(SERIAL_STICK);
		writeModemCredential(device, { username: USERNAME, password: PASSWORD });

		expect(
			recordModemCredentialOutcome(device, "unlocked", 1_700_000_000_000),
		).toBe(true);

		expect(projectModemCredential(device)).toEqual({
			configured: true,
			lastVerifiedAt: 1_700_000_000_000,
			lastOutcome: "unlocked",
		});
		// A rejection must NOT advance the verification stamp.
		expect(recordModemCredentialOutcome(device, "auth-failed")).toBe(true);
		expect(projectModemCredential(device)).toEqual({
			configured: true,
			lastVerifiedAt: 1_700_000_000_000,
			lastOutcome: "auth-failed",
		});
		expect(readModemCredential(device)?.password).toBe(PASSWORD);
	});

	it("is a no-op for a device with nothing stored", async () => {
		await initModemCredentials(tempStorePath());
		const device = resolvePhysicalDevice(SERIAL_STICK);
		expect(recordModemCredentialOutcome(device, "locked")).toBe(false);
		expect(projectModemCredential(device)).toEqual({ configured: false });
	});
});

describe("the wire projection carries no secret", () => {
	it("serializes to a payload containing neither the password nor the username", async () => {
		await initModemCredentials(tempStorePath());
		const device = resolvePhysicalDevice(SERIAL_STICK);
		writeModemCredential(device, {
			username: USERNAME,
			password: PASSWORD,
			lastVerifiedAt: 1_700_000_000_000,
			lastOutcome: "unlocked",
		});

		const serialized = JSON.stringify(projectModemCredential(device));

		expect(serialized).not.toContain(PASSWORD);
		expect(serialized).not.toContain("password");
		expect(serialized).not.toContain("username");
		// Non-vacuity: the projection really did describe a configured device.
		expect(serialized).toContain('"configured":true');

		// The KEY SET is asserted whole, so a field added to the stored entry
		// later cannot ride onto the wire by default.
		expect(Object.keys(projectModemCredential(device)).sort()).toEqual([
			"configured",
			"lastOutcome",
			"lastVerifiedAt",
		]);
	});

	it("says `configured: false` for a device with no stored login", async () => {
		await initModemCredentials(tempStorePath());
		expect(projectModemCredential(resolvePhysicalDevice(TWIN_A))).toEqual({
			configured: false,
		});
	});
});

describe("the REAL logger never emits a device login", () => {
	it("scrubs both halves of a credential attached to an ordinary log line", () => {
		logger.info("modem credential verified", {
			modem: "0",
			username: USERNAME,
			password: PASSWORD,
		});

		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("modem credential verified");
		expect(emitted).toContain(REDACTED);
		expect(emitted).not.toContain(PASSWORD);
		expect(emitted).not.toContain(`"${USERNAME}"`);
	});

	it("scrubs a credential nested under its own container key", () => {
		logger.warn("router admin login rejected", {
			ifname: "wwan2",
			modemCredentials: { username: USERNAME, password: PASSWORD },
		});

		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain(REDACTED);
		expect(emitted).not.toContain(PASSWORD);
		expect(emitted).not.toContain(`"${USERNAME}"`);
		// The non-secret sibling survives, so this is redaction rather than a drop.
		expect(emitted).toContain("wwan2");
	});

	it("scrubs the stored credential object itself through logRedact", () => {
		const redacted = logRedact({
			device: "lnk_0123456789abcdef",
			credential: { username: USERNAME, password: PASSWORD },
		}) as Record<string, unknown>;

		expect(redacted.credential).toBe(REDACTED);
		expect(redacted.device).toBe("lnk_0123456789abcdef");
		expect(JSON.stringify(redacted)).not.toContain(PASSWORD);
	});
});

describe("isCredentialSensitiveKey — anchored, not substring", () => {
	it("matches the keys that genuinely name a device login", () => {
		for (const key of [
			"username",
			"user_name",
			"user-name",
			"gsm.username",
			"credential",
			"credentials",
			"modemCredentials",
			"router_credential",
			"webUiUsername",
			"adminUsername",
			"loginUsername",
		]) {
			expect(isCredentialSensitiveKey(key)).toBe(true);
		}
	});

	it("does NOT over-redact the ordinary keys a substring rule would eat", () => {
		for (const key of [
			"user",
			"userAgent",
			"usernameRequired",
			"hasUsername",
			"credentialsSupported",
			"loginAttempts",
			"name",
			"account",
		]) {
			expect(isCredentialSensitiveKey(key)).toBe(false);
		}
	});
});

describe("the store is NOT part of the runtime config schema", () => {
	const SCHEMA_PATH = "apps/backend/src/helpers/config-schemas.ts";
	// Resolved from this file's own location rather than `process.cwd()`, so the
	// assertion holds whichever workspace the runner was invoked from.
	const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

	it("config-schemas.ts names neither the store file nor any credential field", () => {
		const source = fs.readFileSync(path.join(REPO_ROOT, SCHEMA_PATH), "utf8");

		// Non-vacuity: we really did read the runtime config schema.
		expect(source).toContain("runtimeConfigSchema");

		for (const needle of [
			MODEM_CREDENTIALS_FILE,
			"modem-credentials",
			"modemCredential",
			"modem_credential",
		]) {
			expect(source).not.toContain(needle);
		}
	});

	it("`git grep` over config-schemas.ts finds no reference to the store file", () => {
		const result = Bun.spawnSync({
			cmd: ["git", "grep", "-n", MODEM_CREDENTIALS_FILE, "--", SCHEMA_PATH],
			cwd: path.join(process.cwd(), "../.."),
			stdout: "pipe",
			stderr: "pipe",
		});

		// `git grep` exits 0 ONLY on a match; 1 is a clean miss and 128 means git
		// could not run at all. The file read above is the non-vacuous half, so a
		// git-less environment degrades to that rather than passing silently.
		expect(result.exitCode).not.toBe(0);
		expect(new TextDecoder().decode(result.stdout)).toBe("");
	});
});
