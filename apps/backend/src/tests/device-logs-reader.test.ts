import { describe, expect, test } from "bun:test";
import {
	JournalReadError,
	scanJournal,
} from "../modules/device-logs/reader.ts";
import {
	fakeJournal,
	journalLine,
	scanInput,
} from "./helpers/device-journal.ts";

describe("bounded journal stream", () => {
	test("three records split over arbitrary byte and line boundaries reach EOF", async () => {
		const text =
			journalLine({ MESSAGE: "héllo" }) +
			journalLine({ __CURSOR: "s=2" }) +
			journalLine({ __CURSOR: "s=3" }).trimEnd();
		const bytes = new TextEncoder().encode(text);
		const fake = fakeJournal(Array.from(bytes, (byte) => Uint8Array.of(byte)));
		const records: string[] = [];
		const result = await scanJournal({
			...scanInput,
			spawn: () => fake.child,
			onRecord(record) {
				records.push(record.message);
				return "continue";
			},
		});
		expect(result).toEqual({ status: "eof", exitCode: 0, skippedRecords: 0 });
		expect(records).toEqual(["héllo", "hello", "hello"]);
		expect(fake.signals).toEqual([]);
	});

	test("static argv requests unabridged fields and consumes compiled matches", async () => {
		const fake = fakeJournal([journalLine()]);
		let argv: string[] = [];
		await scanJournal({
			...scanInput,
			options: ["-r", "--cursor=s=1"],
			matches: ["_BOOT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "PRIORITY=3"],
			spawn(args) {
				argv = args;
				return fake.child;
			},
		});
		expect(argv).toEqual([
			"journalctl",
			"-o",
			"json",
			"--all",
			"--output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_BOOT_ID,_TRANSPORT,MESSAGE_ID,UNIT,_PID",
			"-r",
			"--cursor=s=1",
			"--",
			"_BOOT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"PRIORITY=3",
		]);
	});

	test("stop prevents delivery of later buffered records and awaits reap", async () => {
		const fake = fakeJournal([journalLine() + journalLine()], { held: true });
		const seen: string[] = [];
		expect(
			await scanJournal({
				...scanInput,
				spawn: () => fake.child,
				onRecord(record) {
					seen.push(record.cursor);
					return "stop";
				},
			}),
		).toMatchObject({ status: "stopped", exitCode: 143 });
		expect(seen).toEqual(["s=1"]);
		expect(fake.signals).toEqual(["SIGTERM"]);
		expect(await fake.child.exited).toBe(143);
	});

	test("malformed records are skipped and counted while valid neighbors survive", async () => {
		const fake = fakeJournal([
			`{}\n${journalLine()}${journalLine({ __REALTIME_TIMESTAMP: "" })}`,
		]);
		let seen = 0;
		expect(
			await scanJournal({
				...scanInput,
				spawn: () => fake.child,
				onRecord() {
					seen++;
					return "continue";
				},
			}),
		).toMatchObject({ status: "eof", skippedRecords: 2 });
		expect(seen).toBe(1);
	});

	test.each(["{broken}\n", '{"MESSAGE":', "\n", "\0\n"])(
		"invalid JSON %j fails instead of returning partial success",
		async (suffix) => {
			const fake = fakeJournal([journalLine() + suffix], { held: true });
			fake.endOutput();
			const failure = await scanJournal({
				...scanInput,
				spawn: () => fake.child,
			}).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(JournalReadError);
			expect(failure).toMatchObject({ code: "READ_FAILED" });
			expect(fake.signals).toEqual(["SIGTERM"]);
		},
	);

	test("invalid UTF-8 bytes in journal JSON fail explicitly", async () => {
		const fake = fakeJournal([Uint8Array.of(255, 10)]);
		await expect(
			scanJournal({ ...scanInput, spawn: () => fake.child }),
		).rejects.toMatchObject({ code: "READ_FAILED" });
	});

	test.each(["ENOENT", "EACCES"])(
		"spawn %s maps to a typed error",
		async (code) => {
			await expect(
				scanJournal({
					...scanInput,
					spawn() {
						throw Object.assign(new Error("spawn"), { code });
					},
				}),
			).rejects.toMatchObject({
				code: code === "ENOENT" ? "JOURNAL_UNAVAILABLE" : "READ_FAILED",
				name: "JournalReadError",
				stderr: "",
			});
		},
	);

	test.each([1, 137, 143])(
		"unexpected exit %d never becomes EOF",
		async (code) => {
			const fake = fakeJournal([journalLine()], { code, stderr: "failure" });
			await expect(
				scanJournal({ ...scanInput, spawn: () => fake.child }),
			).rejects.toMatchObject({
				code: "READ_FAILED",
				stderr: "failure",
			});
		},
	);

	test("a thrown consumer is propagated after retirement", async () => {
		const fake = fakeJournal([journalLine()], { held: true });
		const error = new Error("consumer");
		await expect(
			scanJournal({
				...scanInput,
				spawn: () => fake.child,
				onRecord() {
					throw error;
				},
			}),
		).rejects.toBe(error);
		expect(Object.hasOwn(error, "stderr")).toBe(false);
		expect(fake.signals).toEqual(["SIGTERM"]);
	});
});
