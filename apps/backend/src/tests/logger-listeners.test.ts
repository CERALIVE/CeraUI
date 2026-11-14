import { expect, test } from "bun:test";
import { ok as assert } from "node:assert/strict";

async function probe(body: string) {
	const child = Bun.spawn(
		[
			"bun",
			"--eval",
			`import { logger, onLogLine, getRecentLogLines, clearRecentLogLines } from ${JSON.stringify(import.meta.resolve("../helpers/logger.ts"))};
			const events = [];
			let reports = 0;
			const originalError = console.error;
			console.error = (...args) => { reports++; originalError(...args); };
			${body}
			await new Promise(resolve => setImmediate(resolve));
			console.log("RESULT " + JSON.stringify({
				events, reports,
				messages: getRecentLogLines().map(line => JSON.parse(line).msg)
			}));
			logger.close();`,
		],
		{
			env: {
				...process.env,
				NODE_ENV: "production",
				MOCK_MODE: "false",
				LOG_LEVEL: "",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	let stdoutBytes = 0;
	// Bound broken feedback loops without imposing a process-startup timing assertion.
	const boundedStdout = (async () => {
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let text = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return text + decoder.decode();
				stdoutBytes += value.byteLength;
				if (stdoutBytes > 64 * 1024) {
					child.kill("SIGKILL");
					await reader.cancel();
					return text;
				}
				text += decoder.decode(value, { stream: true });
			}
		} finally {
			reader.releaseLock();
		}
	})();
	const [stdout, stderr, exit] = await Promise.all([
		boundedStdout,
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stdoutBytes, "probe exceeded its output budget").toBeLessThanOrEqual(
		64 * 1024,
	);
	expect(exit, stderr).toBe(0);
	const line = stdout.split("\n").find((value) => value.startsWith("RESULT "));
	assert(line, stdout);
	return { result: JSON.parse(line.slice(7)), stdout, stderr };
}

test("a throwing subscriber cannot escape, skip peers or stall later ring writes", async () => {
	const output = await probe(`
		const stop = onLogLine(() => { throw new Error("v4.public.abc"); });
		onLogLine((line, seq) => events.push(seq + ":" + JSON.parse(line).msg));
		logger.error("first");
		stop();
		logger.error("second");
	`);
	expect(output.result).toEqual({
		events: ["0:first", "1:second"],
		messages: ["first", "second"],
		reports: 1,
	});
	expect(output.stdout).toContain('<3>{"');
	expect(output.stderr).not.toContain("v4.public.abc");
});

test("a rejecting async subscriber is handled without an unhandled rejection", async () => {
	const output = await probe(`
		const stop = onLogLine(async () => { throw new Error("subscriber rejected"); });
		onLogLine((line, seq) => events.push(seq + ":" + JSON.parse(line).msg));
		logger.error("first");
		await new Promise(resolve => setImmediate(resolve));
		stop();
		logger.error("second");
	`);
	expect(output.result).toEqual({
		events: ["0:first", "1:second"],
		messages: ["first", "second"],
		reports: 1,
	});
	expect(output.stderr).not.toContain("subscriber rejected");
});

test("each line uses a membership snapshot, including safe callback unsubscription", async () => {
	const output = await probe(`
		let stopFirst = () => {};
		let stopSecond = () => {};
		stopFirst = onLogLine(line => {
			events.push("first:" + JSON.parse(line).msg);
			stopFirst();
			stopSecond();
			onLogLine(line => events.push("added:" + JSON.parse(line).msg));
		});
		stopSecond = onLogLine(line => events.push("second:" + JSON.parse(line).msg));
		logger.error("one");
		logger.error("two");
	`);
	expect(output.result).toEqual({
		events: ["first:one", "second:one", "added:two"],
		messages: ["one", "two"],
		reports: 0,
	});
});

test("subscriber failures produce only one bounded non-recursive diagnostic per process", async () => {
	const output = await probe(`
		onLogLine(() => { events.push("failed"); throw new Error("private subscriber detail"); });
		logger.error("one");
		logger.error("two");
		logger.error("three");
	`);
	expect(output.result).toEqual({
		events: ["failed", "failed", "failed"],
		messages: ["one", "two", "three"],
		reports: 1,
	});
	expect(output.stderr.trim()).toBe(
		"Log ring subscriber failed; logging continues",
	);
});

test("an unavailable diagnostic sink cannot propagate or stop the log ring", async () => {
	const output = await probe(`
		console.error = () => { reports++; throw new Error("stderr unavailable"); };
		onLogLine(() => { throw new Error("subscriber failed"); });
		onLogLine(line => events.push(JSON.parse(line).msg));
		logger.error("one");
		logger.error("two");
	`);
	expect(output.result).toEqual({
		events: ["one", "two"],
		messages: ["one", "two"],
		reports: 1,
	});
});

test.each([
	["info", 'logger.info("nested")'],
	["log", 'logger.log("info", "nested")'],
	[
		"write",
		'events.push("write-return:"+logger.write({level:"info",message:"nested"}))',
	],
	[
		"write-encoding",
		'events.push("write-return:"+logger.write({level:"info",message:"nested"}, "utf8", () => events.push("write-callback")))',
	],
	["child", 'logger.child({module:"child"}).info("nested")'],
	["error-metadata", 'logger.error("nested", {err:new Error("detail")})'],
])(
	"synchronous callback logging via %s is retained without redispatch",
	async (kind, action) => {
		const output = await probe(`
  onLogLine((line,seq) => { events.push("writer:"+seq+":"+JSON.parse(line).msg); ${action}; });
  onLogLine((line,seq) => events.push("peer:"+seq+":"+JSON.parse(line).msg));
  logger.error("trigger");
  console.log("RETURNED");
 `);
		const expectedEvents = ["writer:0:trigger"];
		if (kind === "write" || kind === "write-encoding")
			expectedEvents.push("write-return:true");
		expectedEvents.push("peer:0:trigger");
		if (kind === "write-encoding") expectedEvents.push("write-callback");
		expect(output.result).toEqual({
			events: expectedEvents,
			messages: ["trigger", "nested"],
			reports: 0,
		});
		expect(output.stdout).toContain("RETURNED");
		const consoleRecords = output.stdout
			.split("\n")
			.filter((line) => /^<[0-7]>/.test(line))
			.map((line) => JSON.parse(line.slice(3)));
		expect(consoleRecords.map((record) => record.msg)).toEqual([
			"trigger",
			"nested",
		]);
	},
);

test("two nested synchronous logging calls advance the ring but do not recurse", async () => {
	const output = await probe(`
  function nested(depth) { logger.info("nested-"+depth); if (depth < 2) nested(depth+1); }
  onLogLine((line,seq) => { events.push("writer:"+seq); nested(1); });
  onLogLine((line,seq) => events.push("peer:"+seq));
  logger.error("trigger");
 `);
	expect(output.result).toEqual({
		events: ["writer:0", "peer:0"],
		messages: ["trigger", "nested-1", "nested-2"],
		reports: 0,
	});
});

test("nested writes from a record getter are still synchronous callback writes", async () => {
	const output = await probe(`
		onLogLine(() => logger.write({
			level: "info",
			get message() { logger.info("nested-two"); return "nested-one"; }
		}));
		onLogLine((_line, seq) => events.push("peer:" + seq));
		logger.error("trigger");
	`);
	expect(output.result).toEqual({
		events: ["peer:0"],
		messages: ["trigger", "nested-two", "nested-one"],
		reports: 0,
	});
});

test("a later throwing listener cannot leave synchronous dispatch stuck", async () => {
	const output = await probe(`
  onLogLine((line,seq) => { events.push("writer:"+seq); if(JSON.parse(line).msg === "first") logger.info("nested"); });
  onLogLine(() => { throw new Error("private"); });
  onLogLine((line,seq) => events.push("peer:"+seq));
  logger.error("first");
  logger.info("later");
 `);
	expect(output.result).toEqual({
		events: ["writer:0", "peer:0", "writer:2", "peer:2"],
		messages: ["first", "nested", "later"],
		reports: 1,
	});
});

test.each(["microtask", "timer"])(
	"an asynchronously logged line from a %s is dispatched normally",
	async (mode) => {
		const output = await probe(`
  let done;
  const completed = new Promise(resolve => done=resolve);
  onLogLine((line,seq) => {
   const msg = JSON.parse(line).msg; events.push("writer:"+seq+":"+msg);
   if(msg === "first") {
    const emit = () => logger.info("async");
    if ("${mode}" === "timer") setTimeout(emit,0); else queueMicrotask(emit);
   }
   if(msg === "async") done();
  });
  onLogLine((line,seq) => events.push("peer:"+seq+":"+JSON.parse(line).msg));
  logger.error("first");
  await completed;
 `);
		expect(output.result).toEqual({
			events: [
				"writer:0:first",
				"peer:0:first",
				"writer:1:async",
				"peer:1:async",
			],
			messages: ["first", "async"],
			reports: 0,
		});
	},
);

test.each([
	'Symbol.for("listener-reentrant")',
	'"listener-reentrant"',
	'String(Symbol("listener-reentrant"))',
])(
	"asynchronous caller metadata cannot suppress subscriber delivery: %s",
	async (key) => {
		const output = await probe(`
		const completed = new Promise(resolve => {
			onLogLine((line, seq) => {
				const message = JSON.parse(line).msg;
				events.push(seq + ":" + message);
				if (message === "first") queueMicrotask(() => logger.write({
					level: "info",
					message: "later",
					[${key}]: true
				}, resolve));
			});
		});
		logger.error("first");
		await completed;
	`);
		expect(output.result).toEqual({
			events: ["0:first", "1:later"],
			messages: ["first", "later"],
			reports: 0,
		});
	},
);

test("async rejection cannot change the dispatch state of a later call", async () => {
	const output = await probe(`
  onLogLine(async () => { throw new Error("private"); });
  onLogLine((line,seq) => events.push(seq+":"+JSON.parse(line).msg));
  logger.error("first");
  await new Promise(resolve => queueMicrotask(resolve));
  logger.info("later");
 `);
	expect(output.result).toEqual({
		events: ["0:first", "1:later"],
		messages: ["first", "later"],
		reports: 1,
	});
});

test("a caller-owned record reused after a callback is dispatched normally", async () => {
	const output = await probe(`
  const record = {level:"info",message:"reused"};
  onLogLine((line,seq) => { events.push(seq+":"+JSON.parse(line).msg); if (JSON.parse(line).msg === "trigger") logger.write(record); });
  logger.error("trigger");
  logger.write(record);
 `);
	expect(output.result).toEqual({
		events: ["0:trigger", "2:reused"],
		messages: ["trigger", "reused", "reused"],
		reports: 0,
	});
});

test.each(["unsubscribe", "clear", "both"])(
	"the process diagnostic survives %s lifecycle transitions",
	async (transition) => {
		const output = await probe(`
  const stop = onLogLine(() => { throw new Error("first private"); });
  logger.error("first");
  if ("${transition}" !== "clear") stop();
  if ("${transition}" !== "unsubscribe") clearRecentLogLines();
  if ("${transition}" !== "clear") onLogLine(() => { throw new Error("second private"); });
  logger.error("second");
 `);
		expect(output.result.reports).toBe(1);
		expect(output.stderr.trim().split("\n")).toEqual([
			"Log ring subscriber failed; logging continues",
		]);
		expect(output.result.messages).toEqual(
			transition === "unsubscribe" ? ["first", "second"] : ["second"],
		);
	},
);
