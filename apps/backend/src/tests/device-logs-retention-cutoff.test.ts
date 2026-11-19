import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteOlderFiles } from "../modules/device-logs/retention.ts";
import * as updates from "../modules/system/software-updates.ts";
import { bootId } from "./helpers/device-query.ts";
import { retentionFixture } from "./helpers/device-retention.ts";

const priorBoot = "e".repeat(32);
const now = Date.now();
const archive = (seq: string) =>
	`system@${"a".repeat(32)}-${seq.padStart(16, "0")}-0000000000000001.journal`;

function header(name: string, tailBoot: string, age: number, state: string) {
	return [
		`File path: DIRECTORY/${name}`,
		`Boot ID: ${tailBoot}`,
		`State: ${state}`,
		"Compatible flags: TAIL_ENTRY_BOOT_ID",
		`Head realtime timestamp: Thu 2027-01-14 08:00:00 UTC (${((now - age) * 1000).toString(16)})`,
		"Entry objects: 4",
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
		headers: header("system.journal", bootId, 700_000, "ONLINE"),
		seconds: 121,
	},
	{
		name: "archives from previous boots use uptime",
		headers: header(archive("1"), priorBoot, 600_000, "ARCHIVED"),
		seconds: 121,
	},
	{
		name: "the earliest current boot archive head survives a forward clock step",
		headers:
			header(archive("1"), priorBoot, 1_000_000, "ARCHIVED") +
			header(archive("3"), bootId, 400_250, "ARCHIVED") +
			header(archive("2"), bootId, 720_250, "ARCHIVED"),
		seconds: 722,
	},
])("selects a safe vacuum window when $name", async ({ headers, seconds }) => {
	fixture = retentionFixture();
	for (const name of [archive("1"), archive("2"), archive("3")])
		writeFileSync(join(fixture.dir, name), "");
	fixture.read.mockResolvedValue("60.1 0");
	fixture.run.mockImplementation(async (_command, args) => {
		if (args[0] === "--header")
			return headers.replaceAll("DIRECTORY", fixture.dir);
		if (args[0] === "--disk-usage") return "take up 1M";
		return "[]";
	});
	const clock = spyOn(Date, "now").mockReturnValue(now);
	try {
		expect(await deleteOlderFiles()).toMatchObject({ ok: true });
		expect(fixture.run.mock.calls.map(([, args]) => args)).toEqual([
			["--list-boots", "-o", "json"],
			["--header"],
			[`--vacuum-time=${seconds}s`],
			["--list-boots", "-o", "json"],
			["--disk-usage"],
		]);
	} finally {
		clock.mockRestore();
	}
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
