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

/*
  THE SERVER-SIDE ROUTER-WEBUI CREDENTIAL STORE.

  A router-mode dongle's own admin API is the only surface that can answer for
  its configuration, and some units gate it behind a login. That login is the
  OPERATOR's secret, so it lives here — on the device, at 0600, keyed by the
  physical unit it belongs to — and it NEVER rides the wire in either direction.

  ── WHY NOT `config.json` ─────────────────────────────────────────────────

  Same reason `sim-secrets.ts` keeps a SIM PIN out of it: `config.json` is read,
  echoed and broadcast by the whole control plane, so a secret placed there is a
  secret handed to every config reader, every `config` broadcast frame and every
  support bundle. `runtimeConfigSchema` therefore has NO credential field, and a
  grep gate in the test suite keeps it that way.

  ── WHY `/data`, NOT `/run` ───────────────────────────────────────────────

  This is the one place this store diverges from `sim-secrets.ts`. A SIM PIN is
  deliberately volatile — tmpfs, gone on power-off — because its whole job is
  one boot-time auto-unlock and the blast radius of a durable copy is a locked
  SIM. A router login is the opposite: the operator entered it so the device can
  keep reading that dongle across reboots and OTA updates, and losing it on
  every power cycle would make the feature pointless. `/data` is the
  device-persistent partition that survives an A/B slot swap
  (`image-building-pipeline/docs/partition-contract.md`), which is the same
  reason `mutation-journal.ts` pins its journal there.

  ── THE WRITE IS temp → chmod(0600) → rename, IN THAT ORDER ───────────────

  The mode is asserted on the TEMP file, BEFORE the rename publishes it. Doing
  it the other way round — rename first, chmod after — leaves a real window in
  which the secret is readable at whatever the umask allowed, and a crash inside
  that window leaves it readable forever. Because `rename` replaces the inode,
  this also CORRECTS a pre-existing world-readable file on the next write rather
  than inheriting its mode.

  It is a local write rather than `config-loader.ts`'s `writeFileAtomicSync`
  precisely because of that mode contract: the generic helper deliberately does
  not touch permissions (it writes ordinary config), and widening it would make
  every caller pay for a guarantee only a secret needs.

  ── KEYED BY THE PHYSICAL UNIT, NEVER BY A NAME OR AN ADDRESS ─────────────

  The key is `physical-identity.ts`'s minted `link_id`, so it inherits that
  module's ladder verbatim — `usb-serial` ≻ `id-path` — and this file mints
  nothing of its own (the single-id-authority rule).

  Two rungs of that ladder matter here and one is REFUSED:

    - a MAC cannot be the key. The bench HiLink twins are two physically
      distinct dongles publishing ONE factory MAC, so a MAC-keyed store would
      hand one unit's credential to the other.
    - an IFNAME cannot be the key either, and that is why an `ifname`-anchored
      device is refused outright instead of being filed under a weaker key. That
      same twin pair proves it: systemd can name only one of them predictably
      and its sibling falls back to `eth1`, so a name-keyed row would hand the
      NEXT device in that slot the previous unit's login. A refusal costs the
      operator a re-entry; a mis-keyed row posts one dongle's password to
      another.

  Keying on the minted id rather than on the raw identity key has a second
  property worth keeping: a USB serial is a hardware identifier, and the mint is
  a digest, so the document on disk carries no serial at all.
*/

import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { loadCacheFile } from "../../helpers/config-loader.ts";
import { logger } from "../../helpers/logger.ts";
import type { PhysicalDeviceRecord } from "./physical-identity.ts";

/** Device-persistent directory — survives an OTA slot swap. */
export const MODEM_CREDENTIALS_DIR = "/data/ceralive";

/** Store file name. Deliberately its OWN document, never a `config.json` key. */
export const MODEM_CREDENTIALS_FILE = "modem-credentials.json";

/** Written on every save; a future shape change bumps this and migrates on read. */
const STORE_VERSION = 1;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * The five honest lock states a device can be in.
 *
 * `open` is a FIRST-CLASS state rather than an edge case: most units on this
 * fleet require no authentication at all, and rendering a password prompt at
 * one of them would be exactly the dishonesty this surface exists to remove. It
 * must be DETECTED, never assumed — a provider that cannot tell resolves
 * `locked`.
 *
 * Defined here because this store is the first module that has to persist one;
 * the wire projection that publishes it is built on top of this type.
 */
export const MODEM_LOCK_STATES = [
	"open",
	"locked",
	"unlocked",
	"auth-failed",
	"locked-out",
] as const;

export type ModemLockState = (typeof MODEM_LOCK_STATES)[number];

/** One device's stored login. The password NEVER leaves this module's callers. */
export interface ModemCredential {
	readonly username: string;
	readonly password: string;
	/** Epoch ms of the last attempt the device ACCEPTED. */
	readonly lastVerifiedAt?: number;
	/** How the last attempt ended — the honest lock state, not a boolean. */
	readonly lastOutcome?: ModemLockState;
}

/**
 * The ONLY shape that may reach the wire.
 *
 * `configured` answers "is there something stored", which is all an operator
 * surface needs to decide between a prompt and a status line; the secret itself
 * has no representation here, so a projection cannot leak one by omission.
 */
export interface ModemCredentialStatus {
	readonly configured: boolean;
	readonly lastVerifiedAt?: number;
	readonly lastOutcome?: ModemLockState;
}

const entrySchema = z.object({
	username: z.string(),
	password: z.string(),
	/** Which rung anchored the key — diagnostic only, never a lookup input. */
	anchor: z.enum(["usb-serial", "id-path"]).optional(),
	lastVerifiedAt: z.number().optional(),
	lastOutcome: z.enum(MODEM_LOCK_STATES).optional(),
	updatedAt: z.number().optional(),
});

const fileSchema = z.object({
	version: z.literal(STORE_VERSION).optional(),
	devices: z.record(z.string(), entrySchema).optional(),
});

type StoredEntry = z.infer<typeof entrySchema>;

let filePath: string | undefined;
let entries: Record<string, StoredEntry> = {};

/**
 * Writes are inert until `initModemCredentials()` runs. Production calls it once
 * at boot; a unit test that never opts in therefore gets a pure in-memory store
 * and cannot write a secret into the working directory.
 */
let initialized = false;

/**
 * Where the store lives. The override mirrors `CERALIVE_MODEM_MUTATION_DIR`, and
 * the development fallback is cwd-relative exactly like the other config files —
 * a dev host has no `/data`, and refusing to persist there would make the whole
 * feature unexercisable off-device. A real device sets no override and is not in
 * development mode, so it gets the pin.
 */
export function modemCredentialsPath(): string {
	const override = process.env.CERALIVE_MODEM_CREDENTIALS_FILE;
	if (override !== undefined && override !== "") return override;
	const development =
		process.env.NODE_ENV === "development" || process.env.MOCK_MODE === "true";
	return development
		? path.join(process.cwd(), MODEM_CREDENTIALS_FILE)
		: path.join(MODEM_CREDENTIALS_DIR, MODEM_CREDENTIALS_FILE);
}

/**
 * The store key for a resolved physical device, or `undefined` when the device
 * cannot be identified strongly enough to file a secret against.
 *
 * The `ifname` rung is REFUSED — see the header. This is the whole safety
 * argument of the module, so it is a single expression with no fallback.
 */
export function modemCredentialKey(
	device: PhysicalDeviceRecord,
): string | undefined {
	return device.anchor === "ifname" ? undefined : device.linkId;
}

/** temp(0600) → fsync → chmod(0600) → atomic rename. Throws on any step. */
function writeSecretFileAtomicSync(target: string, contents: string): void {
	const dir = path.dirname(target);
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

	const tmpPath = path.join(
		dir,
		`.${path.basename(target)}.${process.pid}.tmp`,
	);

	const fd = fs.openSync(tmpPath, "w", FILE_MODE);
	try {
		fs.writeFileSync(fd, contents);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}

	// `open` honours the umask, and a temp left by an earlier run under a
	// different umask keeps its old mode — so the mode is RE-ASSERTED here
	// rather than assumed, and it happens before the rename publishes the file.
	fs.chmodSync(tmpPath, FILE_MODE);

	try {
		fs.renameSync(tmpPath, target);
	} catch (err) {
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			// Temp already gone; nothing to clean up.
		}
		throw err;
	}
}

function persist(): void {
	if (!initialized || filePath === undefined) return;
	try {
		writeSecretFileAtomicSync(
			filePath,
			JSON.stringify({ version: STORE_VERSION, devices: entries }),
		);
	} catch (err) {
		// A failed credential write must never take a modem surface down with it:
		// the operator loses persistence, not the device. The message names the
		// error only — never the document, which holds the secret.
		logger.warn("modem credentials: failed to persist store", {
			module: "modems",
			error: String(err),
		});
	}
}

/**
 * Load the store from disk and arm persistence. NEVER throws: a missing file
 * starts an empty store, and a corrupt or wrong-shaped one does too — a login
 * the device cannot read back is a login the operator re-enters, which is
 * strictly better than a boot that dies on a damaged secrets file.
 */
export async function initModemCredentials(
	storePath: string = modemCredentialsPath(),
): Promise<void> {
	filePath = storePath;
	const data = await loadCacheFile(storePath, fileSchema, {});
	entries = { ...(data.devices ?? {}) };
	initialized = true;
	const count = Object.keys(entries).length;
	if (count > 0) {
		logger.debug(`modem credentials: loaded ${count} device record(s)`);
	}
}

/**
 * The stored login for a device, INCLUDING the password.
 *
 * THIS IS THE ONE FUNCTION THAT RETURNS THE SECRET. It exists for the
 * device-facing verify path — the code that actually presents the credential to
 * the dongle's admin API — and its result must never be threaded into an RPC
 * procedure's output, a broadcast payload, or a log record. Every operator-
 * facing surface reads {@link projectModemCredential} instead.
 */
export function readModemCredential(
	device: PhysicalDeviceRecord,
): ModemCredential | undefined {
	const key = modemCredentialKey(device);
	if (key === undefined) return undefined;
	const entry = entries[key];
	if (entry === undefined) return undefined;
	return {
		username: entry.username,
		password: entry.password,
		...(entry.lastVerifiedAt !== undefined
			? { lastVerifiedAt: entry.lastVerifiedAt }
			: {}),
		...(entry.lastOutcome !== undefined
			? { lastOutcome: entry.lastOutcome }
			: {}),
	};
}

/**
 * Record (or replace) a device's login. Answers whether anything was stored.
 *
 * Refused when the device carries no strong identity (see
 * {@link modemCredentialKey}) and when the credential is empty on BOTH fields —
 * a device that needs no login is `open`, and `open` is a detected state rather
 * than an empty row in a secrets file.
 */
export function writeModemCredential(
	device: PhysicalDeviceRecord,
	credential: ModemCredential,
): boolean {
	const key = modemCredentialKey(device);
	if (key === undefined) return false;
	if (credential.username === "" && credential.password === "") return false;

	const anchor = device.anchor === "usb-serial" ? "usb-serial" : "id-path";
	entries[key] = {
		username: credential.username,
		password: credential.password,
		anchor,
		...(credential.lastVerifiedAt !== undefined
			? { lastVerifiedAt: credential.lastVerifiedAt }
			: {}),
		...(credential.lastOutcome !== undefined
			? { lastOutcome: credential.lastOutcome }
			: {}),
		updatedAt: Date.now(),
	};
	persist();
	return true;
}

/**
 * Record how the last attempt ended WITHOUT re-handling the password.
 *
 * The outcome moves far more often than the secret does (every verify, every
 * refusal), so making callers read-modify-write the whole credential would push
 * the password through another call site for no reason. A device with nothing
 * stored is a no-op: an outcome is a fact about a credential, not a credential.
 */
export function recordModemCredentialOutcome(
	device: PhysicalDeviceRecord,
	outcome: ModemLockState,
	verifiedAt?: number,
): boolean {
	const key = modemCredentialKey(device);
	if (key === undefined) return false;
	const entry = entries[key];
	if (entry === undefined) return false;

	entries[key] = {
		...entry,
		lastOutcome: outcome,
		...(verifiedAt !== undefined ? { lastVerifiedAt: verifiedAt } : {}),
		updatedAt: Date.now(),
	};
	persist();
	return true;
}

/** Forget a device's login. Idempotent; answers whether a row was removed. */
export function clearModemCredential(device: PhysicalDeviceRecord): boolean {
	const key = modemCredentialKey(device);
	if (key === undefined) return false;
	if (entries[key] === undefined) return false;
	delete entries[key];
	persist();
	return true;
}

/**
 * The wire projection — the ONLY credential-derived shape an operator surface
 * or an RPC procedure may publish.
 *
 * It is built field-by-field rather than by spreading-and-deleting the stored
 * entry, so a field added to {@link StoredEntry} later cannot leak by default.
 */
export function projectModemCredential(
	device: PhysicalDeviceRecord,
): ModemCredentialStatus {
	const key = modemCredentialKey(device);
	const entry = key === undefined ? undefined : entries[key];
	if (entry === undefined) return { configured: false };
	return {
		configured: true,
		...(entry.lastVerifiedAt !== undefined
			? { lastVerifiedAt: entry.lastVerifiedAt }
			: {}),
		...(entry.lastOutcome !== undefined
			? { lastOutcome: entry.lastOutcome }
			: {}),
	};
}

/** Test seam: drop all in-memory state and disarm persistence. */
export function resetModemCredentialsForTest(): void {
	entries = {};
	filePath = undefined;
	initialized = false;
}
