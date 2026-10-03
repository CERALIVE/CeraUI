import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { osStageCandidateKey } from "../modules/system/update-orchestrator/os-stage-retry.ts";
import {
	consumeOsUnlaunchedWitness,
	type OsUnlaunchedWitnessDeps,
	readOsUnlaunchedWitness,
	writeOsUnlaunchedWitness,
} from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { input, manifest } from "./helpers/os-stage-unlaunched-fixture.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function fixture(): OsUnlaunchedWitnessDeps {
	const directory = mkdtempSync(join(tmpdir(), "ceraui-witness-"));
	directories.push(directory);
	chmodSync(directory, 0o700);
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("witness fixture requires Linux uid");
	return { path: join(directory, "witness.json"), uid };
}

describe("private unlaunched settlement witness", () => {
	test("round trips canonical candidate identity when manifest JSON formatting differs", () => {
		const deps = fixture();
		writeOsUnlaunchedWitness(
			{ ...input, manifestJson: JSON.stringify(manifest, null, 2) },
			deps,
		);
		expect(readOsUnlaunchedWitness(deps)).toEqual({
			attemptId: input.attemptId,
			candidateKey: osStageCandidateKey(manifest),
			bootId: input.bootId,
			baselineInstance: input.baselineInstance,
			disposition: "unlaunched-unchanged",
		});
		expect(statSync(deps.path).mode & 0o7777).toBe(0o600);
	});
	test("returns absence when no completed witness exists", () => {
		expect(readOsUnlaunchedWitness(fixture())).toBeNull();
	});
	test("consumes only the requested attempt when another token is supplied", () => {
		const deps = fixture();
		writeOsUnlaunchedWitness(input, deps);
		consumeOsUnlaunchedWitness("another-attempt", deps);
		expect(readOsUnlaunchedWitness(deps)?.attemptId).toBe(input.attemptId);
	});
	test("consumption is durable and idempotent when replayed", () => {
		const deps = fixture();
		writeOsUnlaunchedWitness(input, deps);
		consumeOsUnlaunchedWitness(input.attemptId, deps);
		consumeOsUnlaunchedWitness(input.attemptId, deps);
		expect(readOsUnlaunchedWitness(deps)).toBeNull();
	});
	test.each([
		{ attemptId: "not-uuid" },
		{ bootId: "not-uuid" },
		{ baselineInstance: "0:671" },
		{ baselineInstance: "645:garbled" },
		{ manifestJson: "{" },
		{ manifestJson: JSON.stringify({ ...manifest, schema: 2 }) },
		{ manifestJson: JSON.stringify({ ...manifest, extra: true }) },
	])("refuses invalid write input %j", (change) => {
		const deps = fixture();
		expect(() =>
			writeOsUnlaunchedWitness({ ...input, ...change }, deps),
		).toThrow(OsStageError);
		expect(readOsUnlaunchedWitness(deps)).toBeNull();
	});
	test.each([
		["schema", 2],
		["attemptId", "unknown"],
		["candidateKey", "foreign"],
		["bootId", "unknown"],
		["baselineInstance", "unknown"],
		["disposition", "launched"],
		["completion", "release-requested"],
		["manifest", {}],
		["extra", true],
	])(
		"refuses corrupt %s rather than trusting partial metadata",
		(key, value) => {
			const deps = fixture();
			writeOsUnlaunchedWitness(input, deps);
			const raw: unknown = JSON.parse(readFileSync(deps.path, "utf8"));
			if (typeof raw !== "object" || raw === null)
				throw new Error("fixture invalid");
			writeFileSync(deps.path, JSON.stringify({ ...raw, [key]: value }));
			expect(() => readOsUnlaunchedWitness(deps)).toThrow(OsStageError);
			expect(() => consumeOsUnlaunchedWitness(input.attemptId, deps)).toThrow(
				OsStageError,
			);
		},
	);
	test.each([
		"{",
		"{}",
		"[]",
		'"witness"',
		"null",
		"\ufffd",
		"x".repeat(16_385),
	])("refuses malformed or oversized bytes", (raw) => {
		const deps = fixture();
		writeFileSync(deps.path, raw, { mode: 0o600 });
		expect(() => readOsUnlaunchedWitness(deps)).toThrow(OsStageError);
	});
	test("refuses duplicate JSON fields when canonical serialization differs", () => {
		const deps = fixture();
		writeOsUnlaunchedWitness(input, deps);
		const raw = readFileSync(deps.path, "utf8");
		writeFileSync(
			deps.path,
			raw.replace('"schema":1', '"schema":2,"schema":1'),
		);
		expect(() => readOsUnlaunchedWitness(deps)).toThrow(OsStageError);
	});
	test.each([
		"schema",
		"attemptId",
		"manifest",
		"candidateKey",
		"bootId",
		"baselineInstance",
		"disposition",
		"completion",
	])("refuses missing %s instead of partially trusting a witness", (key) => {
		const deps = fixture();
		writeOsUnlaunchedWitness(input, deps);
		const raw: unknown = JSON.parse(readFileSync(deps.path, "utf8"));
		if (typeof raw !== "object" || raw === null)
			throw new Error("fixture invalid");
		writeFileSync(
			deps.path,
			JSON.stringify(
				Object.fromEntries(
					Object.entries(raw).filter(([name]) => name !== key),
				),
			),
		);
		expect(() => readOsUnlaunchedWitness(deps)).toThrow(OsStageError);
	});
	test("refuses invalid UTF-8 even inside otherwise valid JSON", () => {
		const deps = fixture();
		writeOsUnlaunchedWitness(input, deps);
		const raw = readFileSync(deps.path);
		raw[0] = 0xff;
		writeFileSync(deps.path, raw);
		expect(() => readOsUnlaunchedWitness(deps)).toThrow(OsStageError);
	});
	test.each([
		"symlink",
		"hardlink",
		"directory",
		"mode",
		"owner",
		"parent",
	] as const)("refuses %s tampering on read and write", (kind) => {
		const deps = fixture();
		const other = `${deps.path}.other`;
		writeOsUnlaunchedWitness(input, { ...deps, path: other });
		switch (kind) {
			case "symlink":
				symlinkSync(other, deps.path);
				break;
			case "hardlink":
				linkSync(other, deps.path);
				break;
			case "directory":
				mkdirSync(deps.path);
				break;
			case "mode":
				writeOsUnlaunchedWitness(input, deps);
				chmodSync(deps.path, 0o644);
				break;
			case "owner":
				break;
			case "parent":
				chmodSync(join(deps.path, ".."), 0o777);
				break;
			default: {
				const exhaustive: never = kind;
				return exhaustive;
			}
		}
		const readDeps = kind === "owner" ? { ...deps, uid: deps.uid + 1 } : deps;
		expect(() => readOsUnlaunchedWitness(readDeps)).toThrow(OsStageError);
		expect(() => writeOsUnlaunchedWitness(input, readDeps)).toThrow(
			OsStageError,
		);
	});
	test("retains the completed witness when the writer crashes before rename", async () => {
		const deps = fixture();
		writeOsUnlaunchedWitness(input, deps);
		const code = `
			import { mock } from "bun:test";
			import * as fs from "node:fs";
			mock.module("node:fs", () => ({ ...fs, renameSync: () => process.exit(42) }));
			const { writeOsUnlaunchedWitness } = await import(${JSON.stringify(new URL("../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts", import.meta.url).pathname)});
			writeOsUnlaunchedWitness(${JSON.stringify(input)}, ${JSON.stringify(deps)});
		`;
		const child = Bun.spawn([process.execPath, "--eval", code], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const [exit, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
		]);
		expect({ exit, stderr }).toEqual({ exit: 42, stderr: "" });
		expect(readOsUnlaunchedWitness(deps)?.attemptId).toBe(input.attemptId);
	});
	test("does not overwrite an earlier attempt without explicit consumption", () => {
		const deps = fixture();
		writeOsUnlaunchedWitness(input, deps);
		expect(() =>
			writeOsUnlaunchedWitness({ ...input, attemptId: input.bootId }, deps),
		).toThrow(OsStageError);
		expect(readOsUnlaunchedWitness(deps)?.attemptId).toBe(input.attemptId);
	});
});
