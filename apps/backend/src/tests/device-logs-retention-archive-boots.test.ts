import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logDeleteOlderFilesOutputSchema } from "@ceraui/rpc/schemas";
import { RunTimeoutError } from "../helpers/run.ts";
import { deleteOlderFiles } from "../modules/device-logs/retention.ts";
import { bootId } from "./helpers/device-query.ts";
import {
	archive,
	bootList,
	header,
	priorBoot,
	retentionFixture,
} from "./helpers/device-retention.ts";

const earlierBoot = "f".repeat(32);
let fixture: ReturnType<typeof retentionFixture>;
afterEach(async () => {
	await fixture.restore();
});

test.each([
	{
		name: "two earlier boots",
		list: bootList(earlierBoot, priorBoot),
		kept: false,
	},
	{
		name: "current boot in the list",
		list: bootList(bootId, priorBoot),
		kept: true,
	},
	{
		name: "an interleaved current boot skipped by list-boots",
		list: bootList(priorBoot),
		indexed: `${priorBoot}\n${bootId}\n`,
		kept: true,
	},
	{
		name: "an inconsistent boot index",
		list: bootList(earlierBoot, priorBoot),
		indexed: `${priorBoot}\n`,
		kept: true,
		count: 1,
	},
	{ name: "empty output", list: "", kept: true, count: 1 },
	{ name: "an empty list", list: "[]", kept: true, count: 1 },
	{ name: "garbage output", list: "not a boot list", kept: true, count: 1 },
	{
		name: "a valid earlier boot followed by an invalid row",
		list: bootList(priorBoot, "invalid"),
		kept: true,
		count: 1,
	},
	{ name: "timeout", list: null, kept: true, count: 1 },
])(
	"checks a closed archive with $name",
	async ({ list, indexed, kept, count }) => {
		fixture = retentionFixture();
		const path = join(fixture.dir, archive("1"));
		writeFileSync(path, "journal");
		fixture.run.mockImplementation(async (_command, args) => {
			if (args.includes("--header"))
				return header(args[0]?.slice("--file=".length) ?? "", priorBoot);
			if (args.includes("--list-boots") && args[0]?.startsWith("--file=")) {
				if (list === null)
					throw new RunTimeoutError("journalctl", bootList(priorBoot), "");
				return list;
			}
			if (args.includes("--field=_BOOT_ID"))
				return indexed ?? `${earlierBoot}\n${priorBoot}\n`;
			if (args.includes("--verify")) return "";
			if (args.includes("--disk-usage")) return "take up 1M";
			return "[]";
		});
		const result = await deleteOlderFiles();
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.unverifiedArchivesKept).toBe(count ? true : undefined);
		expect(existsSync(path)).toBe(kept);
	},
);

test("reports unreadable archives and inspects the next with a fresh budget", async () => {
	fixture = retentionFixture();
	const files = ["timeout", "corrupt", "readable"].map((data, i) => {
		const path = join(fixture.dir, archive(String(i + 1)));
		writeFileSync(path, data);
		return path;
	});
	const deadlines = new Set<AbortSignal>();
	fixture.run.mockImplementation(async (_command, args, options) => {
		const file = args[0];
		if (file?.startsWith("--file=")) {
			const pinned = file.slice("--file=".length);
			const data = readFileSync(pinned, "utf8");
			if (args.includes("--header")) return header(pinned, priorBoot);
			if (args.includes("--list-boots")) {
				if (options?.signal) deadlines.add(options.signal);
				if (data === "timeout")
					throw new RunTimeoutError("journalctl", bootList(priorBoot), "");
				return bootList(priorBoot);
			}
			if (args.includes("--field=_BOOT_ID")) return `${priorBoot}\n`;
			if (args.includes("--verify") && data === "corrupt")
				throw new Error("journal verification failed");
			return "";
		}
		return args.includes("--disk-usage") ? "take up 1M" : "[]";
	});
	const result = await deleteOlderFiles();
	expect(result).toMatchObject({
		ok: true,
		unverifiedArchivesKept: true,
	});
	expect(logDeleteOlderFilesOutputSchema.parse(result)).toEqual(result);
	expect(files.map((file) => existsSync(file))).toEqual([true, true, false]);
	expect(deadlines.size).toBe(3);
});
