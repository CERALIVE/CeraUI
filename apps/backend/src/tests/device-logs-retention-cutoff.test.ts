import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArchiveHeader } from "../modules/device-logs/older-journal.ts";
import { deleteOlderFiles } from "../modules/device-logs/retention.ts";
import * as updates from "../modules/system/software-updates.ts";
import { bootId } from "./helpers/device-query.ts";
import { retentionFixture } from "./helpers/device-retention.ts";

const priorBoot = "e".repeat(32);
const firstTs = 1_800_000_000_000;
const machine = "b".repeat(32);
const archive = (seq: string) =>
	`system@${"a".repeat(32)}-${seq.padStart(16, "0")}-0000000000000001.journal`;

function header(path: string, tailBoot: string, flags = " TAIL_ENTRY_BOOT_ID") {
	return [
		`File path: ${path}`,
		`Machine ID: ${machine}`,
		`Boot ID: ${tailBoot}`,
		"State: ARCHIVED",
		`Compatible flags:${flags}`,
		`Tail realtime timestamp: Tue 2023-11-14 22:13:20 UTC (${((firstTs - 1_000) * 1000).toString(16)})`,
		"Entry objects: 1",
		"",
	].join("\n");
}

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
		name: "a clock step makes a current boot archive appear older",
		file: archive("2"),
		entryBoot: bootId,
		kept: true,
	},
])("scopes older deletion when $name", async ({ file, entryBoot, kept }) => {
	fixture = retentionFixture();
	const path = join(fixture.dir, file);
	writeFileSync(path, "journal");
	fixture.run.mockImplementation(async (_command, args) => {
		const pinned = args[0]?.slice("--file=".length) ?? "";
		if (args.includes("--header")) return header(pinned, entryBoot);
		if (args.includes("--output-fields=_BOOT_ID"))
			return JSON.stringify({
				_BOOT_ID: entryBoot,
				__CURSOR: `b=${entryBoot};s=1`,
			});
		if (args.includes("--disk-usage")) return "take up 1M";
		return "[]";
	});
	expect(await deleteOlderFiles()).toMatchObject({ ok: true });
	expect(existsSync(path)).toBe(kept);
	expect(
		fixture.run.mock.calls
			.flatMap(([, args]) => args)
			.filter((arg) => arg.startsWith("--vacuum")),
	).toEqual([]);
});

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
		if (args.includes("--output-fields=_BOOT_ID")) {
			renameSync(path, displaced);
			writeFileSync(path, "replacement");
			return JSON.stringify({
				_BOOT_ID: priorBoot,
				__CURSOR: `b=${priorBoot};s=1`,
			});
		}
		return args.includes("--list-boots") ? "[]" : "take up 1M";
	});
	expect(await deleteOlderFiles()).toMatchObject({ ok: true });
	expect(existsSync(path)).toBe(true);
	expect(existsSync(displaced)).toBe(true);
});

test("keeps existing follows attached while older cleanup drains queries", async () => {
	fixture = retentionFixture();
	fixture.mock.mockReturnValue(true);
	expect(await deleteOlderFiles()).toMatchObject({ ok: true });
	expect(fixture.stop).not.toHaveBeenCalled();
	expect(fixture.abort).toHaveBeenCalledTimes(1);
});
