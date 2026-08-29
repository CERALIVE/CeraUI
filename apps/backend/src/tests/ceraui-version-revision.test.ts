/*
 * Settings → Versions showed CeraUI's OWN row as a bare git short-SHA
 * (`8738fd63`) while every other row beside it — cerastream, SRTLA, Bun, Kernel —
 * showed a real CalVer version.
 *
 * The cause was NOT a broken fallback chain. On a packaged device the primary
 * read SUCCEEDS: `build-debian-package.sh` stamps `/opt/ceralive/revision` and
 * the backend reads it. What was wrong is WHAT that file carries — the commit,
 * which is build metadata, published into a slot an operator reads as a version.
 *
 * So the fix is a resolution LADDER over two build-time facts, and these tests
 * pin all three of its rungs plus the composition rule. The last rung is a
 * regression lock: a dev checkout genuinely has no packaged version, and its
 * bare-SHA behaviour must survive byte-identically.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	composeCeraUiRevision,
	defaultCeraUiRevisionSources,
	getRevisions,
	initRevisions,
	resolveCeraUiRevision,
	setEngineVersionProbe,
} from "../modules/system/revisions.ts";

afterEach(() => {
	setEngineVersionProbe(null);
});

const NO_SOURCES = {
	readVersionStamp: async () => undefined,
	readBuildStamp: async () => undefined,
	readInstalledPackageVersion: async () => undefined,
	readWorkingTreeCommit: () => undefined,
};

describe("the CeraUI row — version rung 1: the build-baked stamp", () => {
	test("a packaged device promotes the CalVer version and demotes the commit", async () => {
		expect(
			await resolveCeraUiRevision({
				...NO_SOURCES,
				readVersionStamp: async () => "2026.8.5",
				readBuildStamp: async () => "8738fd63",
			}),
		).toBe("2026.8.5 (8738fd63)");
	});

	test("the stamp OUTRANKS dpkg — the running build, not whatever is installed", async () => {
		expect(
			await resolveCeraUiRevision({
				...NO_SOURCES,
				readVersionStamp: async () => "2026.8.5",
				readInstalledPackageVersion: async () =>
					"2026.8.4-20260101T000000.dead",
			}),
		).toBe("2026.8.5");
	});

	test("the REAL default readers resolve a stamped tree", async () => {
		const staged = await mkdtemp(join(tmpdir(), "ceraui-version-stamp-"));
		const cwd = process.cwd();
		try {
			await writeFile(join(staged, "version"), "2026.8.5\n");
			await writeFile(join(staged, "revision"), "8738fd63\n");
			process.chdir(staged);
			// The dpkg rung is the only source a temp dir cannot stand in for, and
			// it must not be reached here anyway — the stamp already answered.
			expect(
				await resolveCeraUiRevision({
					readInstalledPackageVersion: async () => undefined,
				}),
			).toBe("2026.8.5 (8738fd63)");
		} finally {
			process.chdir(cwd);
			await rm(staged, { recursive: true, force: true });
		}
	});

	test("an empty stamp file is NOT a version and falls through", async () => {
		const staged = await mkdtemp(join(tmpdir(), "ceraui-version-empty-"));
		const cwd = process.cwd();
		try {
			await writeFile(join(staged, "version"), "\n");
			process.chdir(staged);
			expect(
				await resolveCeraUiRevision({
					readInstalledPackageVersion: async () => "2026.8.4",
					readWorkingTreeCommit: () => undefined,
				}),
			).toBe("2026.8.4");
		} finally {
			process.chdir(cwd);
			await rm(staged, { recursive: true, force: true });
		}
	});
});

describe("the CeraUI row — version rung 2: the installed package", () => {
	test("an absent stamp falls through to the installed package version", async () => {
		expect(
			await resolveCeraUiRevision({
				...NO_SOURCES,
				readInstalledPackageVersion: async () =>
					"2026.8.5-20260829T181141.8738fd63",
			}),
		).toBe("2026.8.5-20260829T181141.8738fd63");
	});

	test("a dpkg version that already embeds the commit does not repeat it", async () => {
		expect(
			await resolveCeraUiRevision({
				...NO_SOURCES,
				readInstalledPackageVersion: async () =>
					"2026.8.5-20260829T181141.8738fd63",
				readWorkingTreeCommit: () => "8738fd63",
			}),
		).toBe("2026.8.5-20260829T181141.8738fd63");
	});

	test("the shipped dpkg reader is gated on a real device, so a dev host gets nothing", async () => {
		expect(
			await defaultCeraUiRevisionSources.readInstalledPackageVersion(),
		).toBeUndefined();
	});
});

describe("the CeraUI row — version rung 3: the dev checkout is unchanged", () => {
	test("no version anywhere falls back to `git rev-parse --short HEAD`, bare", async () => {
		expect(
			await resolveCeraUiRevision({
				...NO_SOURCES,
				readWorkingTreeCommit: () => "8738fd63",
			}),
		).toBe("8738fd63");
	});

	test("a stamped commit with no version is likewise rendered bare", async () => {
		expect(
			await resolveCeraUiRevision({
				...NO_SOURCES,
				readBuildStamp: async () => "8738fd63",
			}),
		).toBe("8738fd63");
	});

	test("nothing readable at all keeps the pre-existing `unknown revision`", async () => {
		expect(await resolveCeraUiRevision(NO_SOURCES)).toBe("unknown revision");
	});

	test("this checkout has no packaged stamp, so the git rung is genuinely reachable", async () => {
		expect(
			await defaultCeraUiRevisionSources.readVersionStamp(),
		).toBeUndefined();
		expect(defaultCeraUiRevisionSources.readWorkingTreeCommit()).toBeTruthy();
	});
});

describe("composeCeraUiRevision", () => {
	test("a version alone is the whole value", () => {
		expect(composeCeraUiRevision("2026.8.5", undefined)).toBe("2026.8.5");
	});

	test("the composed shape is the one splitVersionValue already splits", () => {
		// `<version> (<build>)` is srtla_send's own shape, so the Versions dialog
		// promotes the version and demotes the commit with no schema change.
		expect(composeCeraUiRevision("2026.8.5", "8738fd63")).toMatch(
			/^\S+ \([^()]+\)$/,
		);
	});
});

describe("initRevisions wires the ladder onto the wire", () => {
	test("the published `ceralive` row carries the version, not the bare commit", async () => {
		setEngineVersionProbe(async () => undefined);
		await initRevisions({
			...NO_SOURCES,
			readVersionStamp: async () => "2026.8.5",
			readBuildStamp: async () => "8738fd63",
		});
		expect(getRevisions().ceralive).toBe("2026.8.5 (8738fd63)");
	});
});
