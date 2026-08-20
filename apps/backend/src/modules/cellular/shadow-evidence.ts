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

/**
 * DURABLE shadow evidence — the mechanism the mmcli-retirement gate is measured
 * against.
 *
 * The gate ("≥14 days of shadow on ≥2 devices with zero unexplained divergences")
 * is a claim about a period LONGER than any process lifetime, and longer than the
 * log file's own rotation window. An in-memory counter or a `logger.warn` cannot
 * substantiate it: a reboot resets the first, and `debug.log` ages the second out.
 * So the evidence is written to `/data`, which survives both a restart and an OTA
 * slot swap.
 *
 * Five properties are load-bearing, and each is asserted by a test rather than
 * asserted here:
 *
 * · **BOUNDED.** {@link SHADOW_EVIDENCE_MAX_BYTES} per file ×
 *   {@link SHADOW_EVIDENCE_MAX_FILES} is a hard ceiling. `/data` also holds the
 *   config, the add-on artifacts and the stream markers; an evidence file that can
 *   grow without limit is a way to brick a device with a diagnostic.
 * · **ROTATED.** The current file is renamed aside at the size bound and the
 *   oldest generation is deleted, mirroring the Winston file transport's
 *   `maxsize`/`maxFiles` posture rather than inventing a second one.
 * · **0600, RE-ASSERTED ON EVERY APPEND.** A mode passed at creation does nothing
 *   for a file that already exists (the lesson `sim-secrets.ts` records about
 *   `Bun.write`), so the mode is set explicitly and re-set each time — which also
 *   self-heals a file some earlier build left world-readable.
 * · **OPAQUE IDS.** Records are keyed by `opaqueDeviceKey`, never by an ifname, a
 *   serial or an IMEI, and the file name carries no device identity at all.
 * · **SCHEMA-VERSIONED.** Every line carries `v`. A reader skips a line it cannot
 *   parse or whose version it does not know instead of throwing — one corrupt
 *   line (a torn append across a power cut) must not destroy fourteen days of
 *   evidence.
 *
 * EVERY record crosses {@link redactShadowPayload} at the single append seam, so
 * the redaction guarantee is a property of the writer rather than a discipline
 * each call site has to remember.
 *
 * This module BUILDS the gate's evidence. It never reads it to change behaviour,
 * and nothing here can flip `config.modem_backend`. Deciding the gate is passed is
 * a human act, documented in `docs/MMCLI-RETIREMENT-GATE.md`.
 */

import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

import { logger } from "../../helpers/logger.ts";
import type { ShadowDivergenceKind } from "./shadow-divergence.ts";
import { redactShadowPayload } from "./shadow-redaction.ts";

/** Bumped only for a BREAKING record-shape change; readers skip unknown versions. */
export const SHADOW_EVIDENCE_SCHEMA_VERSION = 1;

/** Base name of the JSONL file; rotated generations are `<base>.<n>.jsonl`. */
export const SHADOW_EVIDENCE_BASENAME = "shadow-evidence";

/** Size at which the current file is rotated aside. */
export const SHADOW_EVIDENCE_MAX_BYTES = 256 * 1024;

/** Current file plus rotated generations — the total ceiling is the product. */
export const SHADOW_EVIDENCE_MAX_FILES = 5;

/** Directory mode; the file mode is 0600. */
export const SHADOW_EVIDENCE_DIR_MODE = 0o700;
export const SHADOW_EVIDENCE_FILE_MODE = 0o600;

/**
 * Heartbeat cadence. A heartbeat is the positive statement "shadow was observing
 * during this window" — without one, a silent day and a day with no divergences
 * are indistinguishable, and the gate would happily count a powered-off device.
 */
export const SHADOW_HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * A day counts toward the 14 only with at least this many heartbeats.
 *
 * 72 = 18 h of the 24 at the 15-minute cadence (96 nominal). The plan does not fix
 * N, so this is a recorded CHOICE: it tolerates a reboot, an update window and a
 * couple of hours of downtime without discarding the day, while refusing to count
 * a day the device spent mostly off. Raising it makes the gate stricter and slower
 * to satisfy; lowering it below ~half a day makes "14 days of shadow" a weaker
 * claim than it sounds.
 */
export const MIN_HEARTBEATS_PER_COMPLETE_DAY = 72;

/** The retirement gate's own thresholds, stated once. */
export const SHADOW_RETIREMENT_GATE_DAYS = 14;
export const SHADOW_RETIREMENT_GATE_DEVICES = 2;

// ── record shapes ────────────────────────────────────────────────────────────

interface ShadowEvidenceBase {
	readonly v: number;
	/** Epoch milliseconds. */
	readonly at: number;
	/** UTC `YYYY-MM-DD`, derived from `at` — the day-completeness bucket key. */
	readonly day: string;
}

export interface ShadowHeartbeatRecord extends ShadowEvidenceBase {
	readonly kind: "heartbeat";
	/** Whether the observer's last list was authoritative (`ok: true`). */
	readonly observationOk: boolean;
	/**
	 * Opaque keys of the modems seen this window. Present so a modem that NEVER
	 * diverges still counts toward the roster — deriving the roster from
	 * divergence records alone would make "we watched N modems" a function of how
	 * badly they disagreed.
	 */
	readonly modemKeys: readonly string[];
	readonly mmcliModems: number;
	readonly dbusModems: number;
	readonly divergences: number;
	/** Rows dropped because their side produced no join key. */
	readonly unjoinableMmcli: number;
	readonly unjoinableDbus: number;
	/** Non-allowlisted D-Bus calls the audit transport refused this session. */
	readonly refusals: number;
}

export interface ShadowDivergenceRecord extends ShadowEvidenceBase {
	readonly kind: "divergence";
	readonly deviceKey: string;
	readonly divergence: ShadowDivergenceKind;
	readonly fields?: Readonly<Record<string, { mmcli: unknown; dbus: unknown }>>;
}

export type ShadowEvidenceRecord =
	| ShadowHeartbeatRecord
	| ShadowDivergenceRecord;

/** What an append site supplies; `v`/`at`/`day` are stamped by the writer. */
export type ShadowEvidenceInput =
	| (Omit<ShadowHeartbeatRecord, "v" | "at" | "day"> & { at?: number })
	| (Omit<ShadowDivergenceRecord, "v" | "at" | "day"> & { at?: number });

export interface ShadowEvidenceDeps {
	/** Overrides the resolved production directory. Tests ALWAYS pass this. */
	readonly baseDir?: string;
	readonly now?: () => number;
}

// ── paths ────────────────────────────────────────────────────────────────────

/**
 * Resolve the production evidence directory. `/data` is the persistent partition
 * that survives an OTA slot swap; `CERALIVE_SHADOW_EVIDENCE_DIR` and
 * `CERALIVE_DATA_DIR` exist so a dev host never has to have one.
 */
export function resolveShadowEvidenceDir(
	env: Record<string, string | undefined> = process.env,
): string {
	const explicit = env.CERALIVE_SHADOW_EVIDENCE_DIR?.trim();
	if (explicit !== undefined && explicit.length > 0) {
		return explicit;
	}
	const dataDir = env.CERALIVE_DATA_DIR?.trim();
	const root = dataDir !== undefined && dataDir.length > 0 ? dataDir : "/data";
	return path.join(root, "ceralive", "shadow");
}

function baseDirOf(deps: ShadowEvidenceDeps): string {
	return deps.baseDir ?? resolveShadowEvidenceDir();
}

/** Generation 0 is the live file; 1..N-1 are the rotated ones. */
export function shadowEvidencePath(baseDir: string, generation = 0): string {
	return generation === 0
		? path.join(baseDir, `${SHADOW_EVIDENCE_BASENAME}.jsonl`)
		: path.join(baseDir, `${SHADOW_EVIDENCE_BASENAME}.${generation}.jsonl`);
}

/** UTC day bucket for an epoch-millisecond timestamp. */
export function evidenceDay(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

// ── writing ──────────────────────────────────────────────────────────────────

function ensureFileMode(file: string): void {
	if (!existsSync(file)) {
		writeFileSync(file, "", { mode: SHADOW_EVIDENCE_FILE_MODE });
	}
	chmodSync(file, SHADOW_EVIDENCE_FILE_MODE);
}

function currentSize(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

/**
 * Rotate `<base>.jsonl` → `.1` → … dropping the oldest generation. Called only
 * when the next line would cross the size bound, so a quiet device never churns.
 */
export function rotateShadowEvidence(baseDir: string): void {
	const oldest = shadowEvidencePath(baseDir, SHADOW_EVIDENCE_MAX_FILES - 1);
	rmSync(oldest, { force: true });
	for (let gen = SHADOW_EVIDENCE_MAX_FILES - 2; gen >= 0; gen -= 1) {
		const from = shadowEvidencePath(baseDir, gen);
		if (!existsSync(from)) {
			continue;
		}
		renameSync(from, shadowEvidencePath(baseDir, gen + 1));
	}
}

/**
 * Append one REDACTED, schema-versioned record. Never throws — evidence
 * collection must not be able to destabilise the live modem path, so a full or
 * read-only `/data` costs a debug line and nothing more.
 */
export function appendShadowEvidence(
	input: ShadowEvidenceInput,
	deps: ShadowEvidenceDeps = {},
): void {
	try {
		const baseDir = baseDirOf(deps);
		const { at: suppliedAt, ...rest } = input;
		const at = suppliedAt ?? deps.now?.() ?? Date.now();
		const record = {
			v: SHADOW_EVIDENCE_SCHEMA_VERSION,
			at,
			day: evidenceDay(at),
			...rest,
		};
		const line = `${JSON.stringify(redactShadowPayload(record))}\n`;

		mkdirSync(baseDir, { recursive: true, mode: SHADOW_EVIDENCE_DIR_MODE });
		const file = shadowEvidencePath(baseDir);
		if (
			currentSize(file) + Buffer.byteLength(line) >
			SHADOW_EVIDENCE_MAX_BYTES
		) {
			rotateShadowEvidence(baseDir);
		}
		ensureFileMode(file);
		appendFileSync(file, line, { mode: SHADOW_EVIDENCE_FILE_MODE });
	} catch (err) {
		logger.debug(`shadow evidence: append failed: ${describe(err)}`);
	}
}

// ── reading ──────────────────────────────────────────────────────────────────

function parseLine(line: string): ShadowEvidenceRecord | undefined {
	if (line.trim().length === 0) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const record = parsed as Partial<ShadowEvidenceRecord>;
	if (record.v !== SHADOW_EVIDENCE_SCHEMA_VERSION) {
		return undefined;
	}
	if (record.kind !== "heartbeat" && record.kind !== "divergence") {
		return undefined;
	}
	if (typeof record.at !== "number" || typeof record.day !== "string") {
		return undefined;
	}
	return record as ShadowEvidenceRecord;
}

/**
 * Read every retained record, OLDEST FIRST across rotated generations. Unparseable
 * and unknown-version lines are skipped silently — see the header.
 */
export function readShadowEvidence(
	deps: ShadowEvidenceDeps = {},
): ShadowEvidenceRecord[] {
	const baseDir = baseDirOf(deps);
	const records: ShadowEvidenceRecord[] = [];
	for (let gen = SHADOW_EVIDENCE_MAX_FILES - 1; gen >= 0; gen -= 1) {
		const file = shadowEvidencePath(baseDir, gen);
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			const record = parseLine(line);
			if (record !== undefined) {
				records.push(record);
			}
		}
	}
	return records;
}

// ── gate summary ─────────────────────────────────────────────────────────────

export interface ShadowEvidenceDay {
	readonly day: string;
	readonly heartbeats: number;
	readonly divergences: number;
	/** `heartbeats >= MIN_HEARTBEATS_PER_COMPLETE_DAY`. */
	readonly complete: boolean;
}

export interface ShadowEvidenceSummary {
	readonly days: readonly ShadowEvidenceDay[];
	readonly completeDays: number;
	/**
	 * Distinct MODEMS this board observed — deliberately not the gate's "≥2
	 * devices", which counts physical CeraLive units and can only be evaluated by
	 * collecting a bundle from each. One board with two modems does not satisfy it.
	 */
	readonly distinctModems: number;
	readonly totalDivergences: number;
	readonly divergencesByKind: Readonly<Record<ShadowDivergenceKind, number>>;
}

/** Fold records into the per-day / per-modem shape the runbook reads. */
export function summarizeShadowEvidence(
	records: readonly ShadowEvidenceRecord[],
): ShadowEvidenceSummary {
	const byDay = new Map<string, { heartbeats: number; divergences: number }>();
	const modems = new Set<string>();
	const byKind: Record<ShadowDivergenceKind, number> = {
		"only-in-mmcli": 0,
		"only-in-dbus": 0,
		"field-mismatch": 0,
	};
	let totalDivergences = 0;

	for (const record of records) {
		const bucket = byDay.get(record.day) ?? { heartbeats: 0, divergences: 0 };
		if (record.kind === "heartbeat") {
			bucket.heartbeats += 1;
			for (const key of record.modemKeys ?? []) {
				modems.add(key);
			}
		} else {
			bucket.divergences += 1;
			totalDivergences += 1;
			modems.add(record.deviceKey);
			if (record.divergence in byKind) {
				byKind[record.divergence] += 1;
			}
		}
		byDay.set(record.day, bucket);
	}

	const days = [...byDay.entries()]
		.map(([day, bucket]) => ({
			day,
			heartbeats: bucket.heartbeats,
			divergences: bucket.divergences,
			complete: bucket.heartbeats >= MIN_HEARTBEATS_PER_COMPLETE_DAY,
		}))
		.sort((a, b) => a.day.localeCompare(b.day));

	return {
		days,
		completeDays: days.filter((d) => d.complete).length,
		distinctModems: modems.size,
		totalDivergences,
		divergencesByKind: byKind,
	};
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
