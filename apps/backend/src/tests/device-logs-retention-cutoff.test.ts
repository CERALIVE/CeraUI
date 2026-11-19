import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import archiveArgv from "../../test-harness/journal-conformance/retention/golden-argv.json";
import { parseArchiveHeader } from "../modules/device-logs/older-journal.ts";
import { deleteOlderFiles } from "../modules/device-logs/retention.ts";
import * as updates from "../modules/system/software-updates.ts";
import { bootId } from "./helpers/device-query.ts";
import {
	archive,
	bootList,
	header,
	priorBoot,
	retentionFixture,
} from "./helpers/device-retention.ts";

let fixture: ReturnType<typeof retentionFixture>;
afterEach(async () => {
	await fixture.restore();
});

test.each([
	{
		name: "cross-boot active file is not an archive",
		file: "system.journal",
		entryBoot: priorBoot,
		kept: true,
	},
	{
		name: "an archive contains only a previous boot",
		file: archive("1"),
		entryBoot: priorBoot,
		kept: false,
	},
	{
		name: "a synthetic follow checkpoint is not archive evidence",
		file: archive("3"),
		entryBoot: priorBoot,
		invalidBootId: `boot-start:${priorBoot}:0`,
		kept: true,
	},
	{
		name: "a clock step makes a current boot archive appear older",
		file: archive("2"),
		entryBoot: bootId,
		kept: true,
	},
])(
	"scopes older deletion when $name",
	async ({ file, entryBoot, invalidBootId, kept }) => {
		fixture = retentionFixture();
		const path = join(fixture.dir, file);
		writeFileSync(path, "journal");
		fixture.run.mockImplementation(async (_command, args) => {
			const pinned = args[0]?.slice("--file=".length) ?? "";
			if (args.includes("--header")) return header(pinned, entryBoot);
			if (args.includes("--field=_BOOT_ID")) return `${entryBoot}\n`;
			if (args.includes("--verify")) return "";
			if (args.includes("--list-boots") && args[0]?.startsWith("--file="))
				return bootList(invalidBootId ?? entryBoot);
			if (args.includes("--disk-usage")) return "take up 1M";
			return "[]";
		});
		expect(await deleteOlderFiles()).toMatchObject({
			ok: true,
			...(invalidBootId ? { unverifiedArchivesKept: true } : {}),
		});
		expect(existsSync(path)).toBe(kept);
		expect(
			fixture.run.mock.calls
				.flatMap(([, args]) => args)
				.filter((arg) => arg.startsWith("--vacuum")),
		).toEqual([]);
	},
);

test.each(["legacy update flag", "busy orchestrator phase"])(
	"older-file cleanup preserves update evidence under the %s",
	async (busyBy) => {
		fixture = retentionFixture();
		const updating = spyOn(updates, "isUpdating").mockReturnValue(
			busyBy === "legacy update flag",
		);
		if (busyBy === "busy orchestrator phase")
			fixture.phase.mockReturnValue({
				...fixture.phase(),
				phase: "committing",
			});
		try {
			expect(await deleteOlderFiles()).toEqual({
				ok: false,
				error: "UPDATE_IN_PROGRESS",
			});
			expect(fixture.run).not.toHaveBeenCalled();
			expect(fixture.stop).not.toHaveBeenCalled();
		} finally {
			updating.mockRestore();
		}
	},
);

test("reports an unrecognized header as kept and preserves the archive", async () => {
	fixture = retentionFixture();
	const path = join(fixture.dir, archive("1"));
	writeFileSync(path, "journal");
	fixture.run.mockImplementation(async (_cmd, args) => {
		if (args.includes("--header")) return "unexpected journalctl output";
		return args.includes("--list-boots") ? "[]" : "take up 1M";
	});
	expect(await deleteOlderFiles()).toMatchObject({
		ok: true,
		unverifiedArchivesKept: true,
	});
	expect(existsSync(path)).toBe(true);
});

test.each([
	"",
	"unexpected journalctl output",
	"Entry objects: 0",
	"File path: /empty",
])("rejects incomplete archive header output %j", (output) => {
	fixture = retentionFixture();
	expect(parseArchiveHeader(output)).toBeNull();
});

test("does not unlink a replacement under the same archived name after proof", async () => {
	fixture = retentionFixture();
	const path = join(fixture.dir, archive("1"));
	const displaced = join(fixture.dir, "displaced.journal");
	writeFileSync(path, "original");
	fixture.run.mockImplementation(async (_cmd, args) => {
		const pinned = args[0]?.slice("--file=".length) ?? "";
		if (args.includes("--header")) return header(pinned, priorBoot);
		if (args.includes("--verify")) {
			renameSync(path, displaced);
			writeFileSync(path, "replacement");
			return "";
		}
		if (args.includes("--field=_BOOT_ID")) return `${priorBoot}\n`;
		if (args.includes("--list-boots") && args[0]?.startsWith("--file="))
			return bootList(priorBoot);
		return args.includes("--list-boots") ? "[]" : "take up 1M";
	});
	expect(await deleteOlderFiles()).toMatchObject({ ok: true });
	expect(existsSync(path)).toBe(true);
	expect(existsSync(displaced)).toBe(true);
	expect(
		fixture.run.mock.calls
			.filter(([, args]) => args[0]?.startsWith("--file="))
			.map(([command, [, ...options]]) => [
				command,
				"--file=<pinned>",
				...options,
			]),
	).toEqual([
		archiveArgv.header,
		archiveArgv.boots,
		archiveArgv.bootIndex,
		archiveArgv.verify,
	]);
});

test("keeps existing follows attached while older cleanup drains queries", async () => {
	fixture = retentionFixture();
	fixture.mock.mockReturnValue(true);
	expect(await deleteOlderFiles()).toMatchObject({ ok: true });
	expect(fixture.stop).not.toHaveBeenCalled();
	expect(fixture.abort).toHaveBeenCalledTimes(1);
});
