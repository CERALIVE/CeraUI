/**
 * Durable shadow-evidence retention.
 *
 * The gate this file protects is a claim about fourteen days, so the evidence has
 * to survive restarts — and the device it survives on has a finite `/data` shared
 * with the config, the add-on artifacts and the stream markers. Bounded, rotated,
 * 0600 and schema-versioned are therefore all correctness properties, not polish.
 *
 * The permission assertion is a REAL `statSync` against a REAL file. "we called
 * chmod" is exactly the claim `sim-secrets.ts` learned not to trust, because a
 * mode passed at creation does nothing to a file that already exists.
 *
 * Nothing here ever writes to a host's `/data`: every case injects `baseDir` into
 * a `mkdtempSync` directory.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	appendShadowEvidence,
	evidenceDay,
	MIN_HEARTBEATS_PER_COMPLETE_DAY,
	readShadowEvidence,
	resolveShadowEvidenceDir,
	SHADOW_EVIDENCE_FILE_MODE,
	SHADOW_EVIDENCE_MAX_BYTES,
	SHADOW_EVIDENCE_MAX_FILES,
	SHADOW_EVIDENCE_SCHEMA_VERSION,
	SHADOW_HEARTBEAT_INTERVAL_MS,
	SHADOW_RETIREMENT_GATE_DAYS,
	shadowEvidencePath,
	summarizeShadowEvidence,
} from "../modules/cellular/shadow-evidence.ts";

let tempDirs: string[] = [];

function dir(): string {
	const created = mkdtempSync(path.join(tmpdir(), "ceralive-shadow-keep-"));
	tempDirs.push(created);
	return created;
}

function heartbeat(at: number, modemKeys: string[] = ["d-aaaa"]) {
	return {
		kind: "heartbeat" as const,
		at,
		observationOk: true,
		modemKeys,
		mmcliModems: modemKeys.length,
		dbusModems: modemKeys.length,
		divergences: 0,
		unjoinableMmcli: 0,
		unjoinableDbus: 0,
		refusals: 0,
	};
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_ONE = Date.UTC(2026, 7, 1, 0, 0, 0);

afterEach(() => {
	for (const created of tempDirs) {
		rmSync(created, { recursive: true, force: true });
	}
	tempDirs = [];
});

describe("records are schema-versioned JSONL", () => {
	test("every line carries the schema version and a UTC day bucket", () => {
		const base = dir();
		appendShadowEvidence(heartbeat(DAY_ONE), { baseDir: base });
		const line = readFileSync(shadowEvidencePath(base), "utf8").trim();
		const parsed = JSON.parse(line) as Record<string, unknown>;
		expect(parsed.v).toBe(SHADOW_EVIDENCE_SCHEMA_VERSION);
		expect(parsed.day).toBe("2026-08-01");
		expect(parsed.at).toBe(DAY_ONE);
	});

	test("a line the reader cannot place is SKIPPED, never fatal", () => {
		const base = dir();
		appendShadowEvidence(heartbeat(DAY_ONE), { baseDir: base });
		const file = shadowEvidencePath(base);
		writeFileSync(
			file,
			[
				readFileSync(file, "utf8").trim(),
				"{ this is not json",
				JSON.stringify({ v: 999, kind: "heartbeat", at: DAY_ONE, day: "x" }),
				JSON.stringify({ v: SHADOW_EVIDENCE_SCHEMA_VERSION, kind: "nope" }),
				"",
			].join("\n"),
		);
		expect(readShadowEvidence({ baseDir: base })).toHaveLength(1);
	});

	test("a divergence record round-trips through the reader", () => {
		const base = dir();
		appendShadowEvidence(
			{
				kind: "divergence",
				at: DAY_ONE,
				deviceKey: "d-abcd",
				divergence: "field-mismatch",
				fields: { networkType: { mmcli: "4G", dbus: "5G" } },
			},
			{ baseDir: base },
		);
		const [record] = readShadowEvidence({ baseDir: base });
		expect(record?.kind).toBe("divergence");
		expect((record as { divergence: string }).divergence).toBe(
			"field-mismatch",
		);
	});
});

describe("the file is 0600, and that is verified against the filesystem", () => {
	test("a freshly created evidence file is owner-read/write only", () => {
		const base = dir();
		appendShadowEvidence(heartbeat(DAY_ONE), { baseDir: base });
		const mode = statSync(shadowEvidencePath(base)).mode & 0o777;
		expect(mode).toBe(SHADOW_EVIDENCE_FILE_MODE);
	});

	test("a file some earlier build left world-readable is REPAIRED on the next append", () => {
		const base = dir();
		appendShadowEvidence(heartbeat(DAY_ONE), { baseDir: base });
		const file = shadowEvidencePath(base);
		writeFileSync(file, "", { mode: 0o644 });
		chmodSync(file, 0o644);
		expect(statSync(file).mode & 0o777).toBe(0o644);

		appendShadowEvidence(heartbeat(DAY_ONE + 1), { baseDir: base });
		expect(statSync(file).mode & 0o777).toBe(SHADOW_EVIDENCE_FILE_MODE);
	});

	test("rotated generations are 0600 too", () => {
		const base = dir();
		const big = "x".repeat(4096);
		for (let i = 0; i < 200; i += 1) {
			appendShadowEvidence(
				{
					kind: "divergence",
					at: DAY_ONE + i,
					deviceKey: `d-${big}`,
					divergence: "only-in-mmcli",
				},
				{ baseDir: base },
			);
		}
		const rotated = shadowEvidencePath(base, 1);
		expect(existsSync(rotated)).toBe(true);
		expect(statSync(rotated).mode & 0o777).toBe(SHADOW_EVIDENCE_FILE_MODE);
	});
});

describe("retention is BOUNDED and rotated", () => {
	test("no single file exceeds the size bound", () => {
		const base = dir();
		const big = "y".repeat(2048);
		for (let i = 0; i < 400; i += 1) {
			appendShadowEvidence(
				{
					kind: "divergence",
					at: DAY_ONE + i,
					deviceKey: `d-${big}`,
					divergence: "only-in-dbus",
				},
				{ baseDir: base },
			);
		}
		for (let gen = 0; gen < SHADOW_EVIDENCE_MAX_FILES; gen += 1) {
			const file = shadowEvidencePath(base, gen);
			if (!existsSync(file)) {
				continue;
			}
			expect(statSync(file).size).toBeLessThanOrEqual(
				SHADOW_EVIDENCE_MAX_BYTES,
			);
		}
	});

	test("the oldest generation is AGED OUT — the ceiling really is a ceiling", () => {
		const base = dir();
		const big = "z".repeat(4096);
		for (let i = 0; i < 1200; i += 1) {
			appendShadowEvidence(
				{
					kind: "divergence",
					at: DAY_ONE + i,
					deviceKey: `d-${big}`,
					divergence: "only-in-mmcli",
				},
				{ baseDir: base },
			);
		}
		expect(
			existsSync(shadowEvidencePath(base, SHADOW_EVIDENCE_MAX_FILES)),
		).toBe(false);

		let total = 0;
		for (let gen = 0; gen < SHADOW_EVIDENCE_MAX_FILES; gen += 1) {
			const file = shadowEvidencePath(base, gen);
			if (existsSync(file)) {
				total += statSync(file).size;
			}
		}
		expect(total).toBeLessThanOrEqual(
			SHADOW_EVIDENCE_MAX_BYTES * SHADOW_EVIDENCE_MAX_FILES,
		);
	});

	test("the reader spans rotated generations, oldest first", () => {
		const base = dir();
		const big = "w".repeat(4096);
		for (let i = 0; i < 200; i += 1) {
			appendShadowEvidence(
				{
					kind: "divergence",
					at: DAY_ONE + i,
					deviceKey: `d-${big}`,
					divergence: "only-in-mmcli",
				},
				{ baseDir: base },
			);
		}
		expect(existsSync(shadowEvidencePath(base, 1))).toBe(true);
		const records = readShadowEvidence({ baseDir: base });
		expect(records.length).toBeGreaterThan(0);
		for (let i = 1; i < records.length; i += 1) {
			expect(records[i]?.at ?? 0).toBeGreaterThanOrEqual(
				records[i - 1]?.at ?? 0,
			);
		}
	});

	test("an unwritable base path costs a debug line, never a throw", () => {
		expect(() =>
			appendShadowEvidence(heartbeat(DAY_ONE), {
				baseDir: "/proc/ceralive-cannot-exist",
			}),
		).not.toThrow();
	});
});

describe("a day counts only with enough heartbeats", () => {
	test("the threshold is derived from the cadence, not picked at random", () => {
		const nominalPerDay = DAY_MS / SHADOW_HEARTBEAT_INTERVAL_MS;
		expect(nominalPerDay).toBe(96);
		expect(MIN_HEARTBEATS_PER_COMPLETE_DAY).toBe(72);
		expect(MIN_HEARTBEATS_PER_COMPLETE_DAY).toBeLessThan(nominalPerDay);
		expect(MIN_HEARTBEATS_PER_COMPLETE_DAY).toBeGreaterThan(nominalPerDay / 2);
	});

	test("one heartbeat short of the threshold leaves the day INCOMPLETE", () => {
		const base = dir();
		for (let i = 0; i < MIN_HEARTBEATS_PER_COMPLETE_DAY - 1; i += 1) {
			appendShadowEvidence(heartbeat(DAY_ONE + i * 1000), { baseDir: base });
		}
		const summary = summarizeShadowEvidence(
			readShadowEvidence({ baseDir: base }),
		);
		expect(summary.days[0]?.heartbeats).toBe(
			MIN_HEARTBEATS_PER_COMPLETE_DAY - 1,
		);
		expect(summary.days[0]?.complete).toBe(false);
		expect(summary.completeDays).toBe(0);
	});

	test("exactly the threshold completes the day", () => {
		const base = dir();
		for (let i = 0; i < MIN_HEARTBEATS_PER_COMPLETE_DAY; i += 1) {
			appendShadowEvidence(heartbeat(DAY_ONE + i * 1000), { baseDir: base });
		}
		const summary = summarizeShadowEvidence(
			readShadowEvidence({ baseDir: base }),
		);
		expect(summary.days[0]?.complete).toBe(true);
		expect(summary.completeDays).toBe(1);
	});

	test("a DIVERGENCE-only day never counts — silence is not observation", () => {
		const base = dir();
		for (let i = 0; i < 500; i += 1) {
			appendShadowEvidence(
				{
					kind: "divergence",
					at: DAY_ONE + i,
					deviceKey: "d-abcd",
					divergence: "field-mismatch",
				},
				{ baseDir: base },
			);
		}
		const summary = summarizeShadowEvidence(
			readShadowEvidence({ baseDir: base }),
		);
		expect(summary.completeDays).toBe(0);
		expect(summary.totalDivergences).toBe(500);
	});

	test("days are counted per UTC day and reported in order", () => {
		const base = dir();
		for (const dayOffset of [2, 0, 1]) {
			for (let i = 0; i < MIN_HEARTBEATS_PER_COMPLETE_DAY; i += 1) {
				appendShadowEvidence(
					heartbeat(DAY_ONE + dayOffset * DAY_MS + i * 1000),
					{ baseDir: base },
				);
			}
		}
		const summary = summarizeShadowEvidence(
			readShadowEvidence({ baseDir: base }),
		);
		expect(summary.days.map((d) => d.day)).toEqual([
			"2026-08-01",
			"2026-08-02",
			"2026-08-03",
		]);
		expect(summary.completeDays).toBe(3);
		expect(summary.completeDays).toBeLessThan(SHADOW_RETIREMENT_GATE_DAYS);
	});

	test("evidenceDay buckets on UTC, so a local midnight cannot split a day", () => {
		expect(evidenceDay(Date.UTC(2026, 7, 1, 23, 59, 59))).toBe("2026-08-01");
		expect(evidenceDay(Date.UTC(2026, 7, 2, 0, 0, 0))).toBe("2026-08-02");
	});
});

describe("the modem roster does not depend on how badly the sides disagreed", () => {
	test("a modem that NEVER diverges still counts toward the roster", () => {
		const base = dir();
		appendShadowEvidence(heartbeat(DAY_ONE, ["d-aaaa", "d-bbbb"]), {
			baseDir: base,
		});
		const summary = summarizeShadowEvidence(
			readShadowEvidence({ baseDir: base }),
		);
		expect(summary.distinctModems).toBe(2);
		expect(summary.totalDivergences).toBe(0);
	});

	test("divergence kinds are counted separately", () => {
		const base = dir();
		for (const kind of [
			"only-in-mmcli",
			"only-in-mmcli",
			"only-in-dbus",
			"field-mismatch",
		] as const) {
			appendShadowEvidence(
				{
					kind: "divergence",
					at: DAY_ONE,
					deviceKey: "d-abcd",
					divergence: kind,
				},
				{ baseDir: base },
			);
		}
		const summary = summarizeShadowEvidence(
			readShadowEvidence({ baseDir: base }),
		);
		expect(summary.divergencesByKind).toEqual({
			"only-in-mmcli": 2,
			"only-in-dbus": 1,
			"field-mismatch": 1,
		});
	});
});

describe("the production path resolves under /data, and tests never touch it", () => {
	test("the default directory is on the persistent partition", () => {
		expect(resolveShadowEvidenceDir({})).toBe("/data/ceralive/shadow");
	});

	test("both overrides are honoured, so a dev host is never forced to have /data", () => {
		expect(resolveShadowEvidenceDir({ CERALIVE_DATA_DIR: "/srv/x" })).toBe(
			"/srv/x/ceralive/shadow",
		);
		expect(
			resolveShadowEvidenceDir({ CERALIVE_SHADOW_EVIDENCE_DIR: "/srv/direct" }),
		).toBe("/srv/direct");
	});

	test("an injected baseDir wins over the resolved default", () => {
		const base = dir();
		appendShadowEvidence(heartbeat(DAY_ONE), { baseDir: base });
		expect(existsSync(shadowEvidencePath(base))).toBe(true);
		expect(existsSync("/data/ceralive/shadow/shadow-evidence.jsonl")).toBe(
			false,
		);
	});
});
