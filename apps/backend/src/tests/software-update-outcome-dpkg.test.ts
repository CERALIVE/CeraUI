/// <reference types="bun" />
/*
 * The outcome reader against the real dpkg-query and dpkg of this host, on an
 * inert database of its own (`--admindir`): which instance and version dpkg
 * itself reports and how dpkg itself orders versions decide, not a fake.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateTarget } from "@ceraui/rpc/schemas";
import { spawnWithTimeout } from "../helpers/spawn-policy.ts";
import { readUpdateOutcome } from "../modules/system/software-update-outcome.ts";

let root: string;
let native: string;
let foreign: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "outcome-dpkg-"));
	const arch = await spawnWithTimeout(["dpkg", "--print-architecture"]);
	expect(arch.exitCode).toBe(0);
	native = arch.stdout.trim();
	foreign = native === "arm64" ? "amd64" : "arm64";
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

type Installed = {
	readonly name: string;
	readonly arch: string;
	readonly version: string;
	readonly status?: string;
	readonly multiArch?: string;
};

let databases = 0;
/** A dpkg database holding exactly these package instances. */
async function database(...installed: Installed[]): Promise<string> {
	const dir = join(root, `db${++databases}`);
	await mkdir(join(dir, "info"), { recursive: true });
	await mkdir(join(dir, "updates"));
	await writeFile(join(dir, "available"), "");
	await writeFile(
		join(dir, "status"),
		installed
			.map(
				(p) =>
					`Package: ${p.name}\nStatus: ${p.status ?? "install ok installed"}\nPriority: optional\nSection: misc\nInstalled-Size: 1\nMaintainer: Test <test@example.invalid>\nArchitecture: ${p.arch}\nMulti-Arch: ${p.multiArch ?? "same"}\nVersion: ${p.version}\nDescription: test\n`,
			)
			.join("\n"),
	);
	return dir;
}

/** The production reader, with dpkg-query pointed at `admindir`. */
function read(admindir: string, targets: UpdateTarget[]) {
	return readUpdateOutcome(targets, {
		inspect: async () => ({ kind: "absent" }),
		observed: () => false,
		now: Date.now,
		run: (argv, opts) =>
			spawnWithTimeout(
				argv[0] === "dpkg-query"
					? ["dpkg-query", `--admindir=${admindir}`, ...argv.slice(1)]
					: argv,
				opts,
			),
	});
}
const target = (o: Partial<UpdateTarget> = {}): UpdateTarget => ({
	name: "demo-pkg",
	version: "2",
	arch: native,
	from: "1",
	...o,
});

describe("the admitted instance, as dpkg reports it", () => {
	test("a foreign instance at the version never confirms a native target", async () => {
		const db = await database({
			name: "demo-pkg",
			arch: foreign,
			version: "3",
		});
		expect(await read(db, [target()])).toEqual({ kind: "unknown" });
		// The same instance confirms a true foreign pin.
		expect(
			await read(db, [target({ name: `demo-pkg:${foreign}`, arch: foreign })]),
		).toEqual({ kind: "success" });
	});

	test("with both architectures installed, each target reads its own", async () => {
		const db = await database(
			{ name: "demo-pkg", arch: native, version: "2" },
			{ name: "demo-pkg", arch: foreign, version: "1" },
		);
		expect(await read(db, [target()])).toEqual({ kind: "success" });
		expect(
			await read(db, [target({ name: `demo-pkg:${foreign}`, arch: foreign })]),
		).toEqual({ kind: "unknown" });
	});

	test("a native instance alone, and an architecture-independent one", async () => {
		const db = await database(
			{ name: "demo-pkg", arch: native, version: "2" },
			{ name: "indep", arch: "all", version: "2", multiArch: "foreign" },
		);
		expect(
			await read(db, [target(), target({ name: "indep", arch: "all" })]),
		).toEqual({ kind: "success" });
	});

	test("a target the install had not reached yet is not confirmed", async () => {
		const db = await database({ name: "demo-pkg", arch: native, version: "1" });
		expect(await read(db, [target()])).toEqual({ kind: "unknown" });
	});
});

describe("a version already there before the run proves nothing", () => {
	test.each([
		["a downgrade from 3", "3"],
		["a reinstall of 2", "2"],
	])("%s: not confirmed", async (_, from) => {
		const db = await database({ name: "demo-pkg", arch: native, version: "3" });
		expect(await read(db, [target({ from })])).toEqual({ kind: "unknown" });
	});

	test("an upgrade from 1, and a new install, are this run's", async () => {
		const db = await database(
			{ name: "demo-pkg", arch: native, version: "3" },
			{ name: "fresh", arch: native, version: "2" },
		);
		expect(
			await read(db, [target(), { name: "fresh", version: "2", arch: native }]),
		).toEqual({ kind: "success" });
	});
});

describe("dpkg's own order and states", () => {
	test.each([
		["2026.11.3~rc1", "unknown"],
		["2026.11.3", "success"],
		["2026.11.3+b1", "success"],
		["1:2026.1.0", "success"],
	] as const)(
		"installed %s for target 2026.11.3: %s",
		async (version, kind) => {
			const db = await database({ name: "demo-pkg", arch: native, version });
			expect(
				await read(db, [target({ version: "2026.11.3", from: "2026.11.2" })]),
			).toEqual({ kind });
		},
	);

	test.each([
		["install ok installed", "success"],
		["hold ok installed", "success"],
		["install reinstreq installed", "unknown"],
		["install ok half-configured", "unknown"],
		["install ok unpacked", "unknown"],
		["deinstall ok config-files", "unknown"],
	] as const)("dpkg status %j: %s", async (status, kind) => {
		const db = await database({
			name: "demo-pkg",
			arch: native,
			version: "2",
			status,
		});
		expect(await read(db, [target()])).toEqual({ kind });
	});
});
