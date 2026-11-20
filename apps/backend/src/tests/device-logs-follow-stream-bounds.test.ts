import { expect, test } from "bun:test";
import { readFollowOutput } from "../modules/device-logs/follow-stream.ts";
import { JournalReadError } from "../modules/device-logs/reader.ts";
import { processOutput } from "./helpers/device-follow-output.ts";
import { journalLine, journalObject } from "./helpers/device-journal-record.ts";

test.each([true, false])(
	"an oversized record is bounded with newline=%s",
	async (newline) => {
		await expect(
			readFollowOutput(
				processOutput(["x".repeat(1024 * 1024 + 1) + (newline ? "\n" : "")]),
				() => "continue",
			),
		).rejects.toEqual(new JournalReadError("RECORD_TOO_LARGE"));
	},
);

test("two large valid records in one chunk each receive their own byte allowance", async () => {
	const seen: string[] = [];
	await readFollowOutput(
		processOutput([
			[1, 2]
				.map((n) =>
					journalLine({ __CURSOR: `s=${n}`, MESSAGE: "x".repeat(600000) }),
				)
				.join(""),
		]),
		(r) => {
			seen.push(r.cursor);
			return "continue";
		},
	);
	expect(seen).toEqual(["s=1", "s=2"]);
});

test("an exact-limit final record without newline retains pending bytes across three chunks", async () => {
	const base = JSON.stringify(journalObject({ MESSAGE: "" }));
	const line = JSON.stringify(
		journalObject({
			MESSAGE: "x".repeat(
				1024 * 1024 - new TextEncoder().encode(base).byteLength,
			),
		}),
	);
	const seen: string[] = [];
	await readFollowOutput(
		processOutput([
			line.slice(0, 15),
			line.slice(15, 500000),
			line.slice(500000),
		]),
		(r) => {
			seen.push(r.message);
			return "continue";
		},
	);
	expect(seen).toEqual(["x".repeat(16 * 1024)]);
});

test.each([true, false])(
	"a record of exactly 1 MiB is accepted across chunks=%s",
	async (split) => {
		const base = JSON.stringify(journalObject({ MESSAGE: "" }));
		const line = JSON.stringify(
			journalObject({
				MESSAGE: "x".repeat(
					1024 * 1024 - new TextEncoder().encode(base).byteLength,
				),
			}),
		);
		const seen: string[] = [];
		await readFollowOutput(
			processOutput(
				split
					? [line.slice(0, 500000), `${line.slice(500000)}\n`]
					: [`${line}\n`],
			),
			(r) => {
				seen.push(r.message);
				return "continue";
			},
		);
		expect(seen).toEqual(["x".repeat(16 * 1024)]);
	},
);
