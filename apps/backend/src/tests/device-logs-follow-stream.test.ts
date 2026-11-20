import { expect, spyOn, test } from "bun:test";
import { readFollowOutput } from "../modules/device-logs/follow-stream.ts";
import { JournalReadError } from "../modules/device-logs/reader.ts";
import { processOutput } from "./helpers/device-follow-output.ts";
import { journalLine, journalObject } from "./helpers/device-journal-record.ts";

test("chunked UTF-8 and an unterminated final JSON record preserve journal order", async () => {
	const bytes = new TextEncoder().encode(
		journalLine({ __CURSOR: "s=1", MESSAGE: "é" }),
	);
	const split = bytes.indexOf(195) + 1;
	const seen: string[] = [];
	await readFollowOutput(
		processOutput([
			bytes.slice(0, split),
			bytes.slice(split),
			JSON.stringify(journalObject({ __CURSOR: "s=2" })),
		]),
		(r) => {
			seen.push(r.cursor);
			return "continue";
		},
	);
	expect(seen).toEqual(["s=1", "s=2"]);
});

test("callback stop prevents parsing later records in the same chunk", async () => {
	const seen: string[] = [];
	await readFollowOutput(
		processOutput([`${journalLine({ __CURSOR: "s=1" })}malformed\n`]),
		(r) => {
			seen.push(r.cursor);
			return "stop";
		},
	);
	expect(seen).toEqual(["s=1"]);
});

test("invalid journal records are skipped without inventing a checkpoint", async () => {
	const seen: string[] = [];
	await readFollowOutput(
		processOutput(["{}\n", journalLine({ __CURSOR: "valid" })]),
		(r) => {
			seen.push(r.cursor);
			return "continue";
		},
	);
	expect(seen).toEqual(["valid"]);
});

test.each(["{oops}\n", new Uint8Array([255, 10])])(
	"malformed transport fails rather than delivering partial success",
	async (chunk) => {
		await expect(
			readFollowOutput(processOutput([chunk]), () => "continue"),
		).rejects.toEqual(new JournalReadError("READ_FAILED"));
	},
);

test("a delimiter at the start of the next chunk completes the pending record", async () => {
	const seen: string[] = [];
	await readFollowOutput(
		processOutput([
			JSON.stringify(journalObject({ __CURSOR: "s=1" })),
			`\n${journalLine({ __CURSOR: "s=2" })}`,
		]),
		(r) => {
			seen.push(r.cursor);
			return "continue";
		},
	);
	expect(seen).toEqual(["s=1", "s=2"]);
});

test("an empty transport record between valid records fails instead of being hidden as whitespace", async () => {
	const seen: string[] = [];
	await expect(
		readFollowOutput(
			processOutput([
				`${journalLine({ __CURSOR: "s=1" })}\n${journalLine({ __CURSOR: "s=2" })}`,
			]),
			(r) => {
				seen.push(r.cursor);
				return "continue";
			},
		),
	).rejects.toEqual(new JournalReadError("READ_FAILED"));
	expect(seen).toEqual(["s=1"]);
});

test("draining stderr allows a backpressured child to finish stdout", async () => {
	const drained = Promise.withResolvers<void>();
	let chunks = 0;
	const proc = processOutput([]);
	const child = {
		...proc,
		stdout: new ReadableStream<Uint8Array>({
			async start(c) {
				await drained.promise;
				c.enqueue(
					new TextEncoder().encode(journalLine({ __CURSOR: "after-stderr" })),
				);
				c.close();
			},
		}),
		stderr: new ReadableStream<Uint8Array>(
			{
				pull(c) {
					if (++chunks <= 2) c.enqueue(new Uint8Array(90000));
					else {
						c.close();
						drained.resolve();
					}
				},
			},
			{ highWaterMark: 0 },
		),
	};
	const seen: string[] = [];
	await readFollowOutput(child, (r) => {
		seen.push(r.cursor);
		return "continue";
	});
	expect(seen).toEqual(["after-stderr"]);
});

test("pipe cancellation starts and releases locks without waiting for its hook", async () => {
	const cancelling = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const proc = {
		...processOutput([]),
		stdout: new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode(journalLine()));
			},
			cancel() {
				cancelling.resolve();
				return released.promise;
			},
		}),
	};
	const task = readFollowOutput(proc, () => "stop");
	try {
		await cancelling.promise;
		await task;
		expect(proc.stdout.locked).toBe(false);
		expect(proc.stderr?.locked).toBe(false);
	} finally {
		released.resolve();
	}
});

test("an unexpected decoder failure retains its identity", async () => {
	const failure = new RangeError("decoder failure");
	const parser = spyOn(JSON, "parse").mockImplementation(() => {
		throw failure;
	});
	try {
		await expect(
			readFollowOutput(processOutput([journalLine()]), () => "continue"),
		).rejects.toBe(failure);
	} finally {
		parser.mockRestore();
	}
});

test("missing pipes fail explicitly", async () => {
	await expect(
		readFollowOutput(
			{ exited: Promise.resolve(0), exitCode: 0, signalCode: null, kill() {} },
			() => "continue",
		),
	).rejects.toEqual(new JournalReadError("READ_FAILED"));
});

test("either missing pipe fails explicitly before acquiring the other", async () => {
	const { stdout: _out, ...withoutStdout } = processOutput([]);
	const { stderr: _err, ...withoutStderr } = processOutput([]);
	for (const proc of [withoutStdout, withoutStderr])
		await expect(readFollowOutput(proc, () => "continue")).rejects.toEqual(
			new JournalReadError("READ_FAILED"),
		);
});

test("invalid UTF-8 inside otherwise valid JSON is rejected rather than replaced", async () => {
	const json = JSON.stringify(journalObject({ MESSAGE: "PLACEHOLDER" }));
	const position = json.indexOf("PLACEHOLDER");
	const prefix = new TextEncoder().encode(json.slice(0, position));
	const suffix = new TextEncoder().encode(
		json.slice(position + "PLACEHOLDER".length),
	);
	const bad = new Uint8Array([...prefix, 255, ...suffix, 10]);
	await expect(
		readFollowOutput(processOutput([bad]), () => "continue"),
	).rejects.toEqual(new JournalReadError("READ_FAILED"));
});
