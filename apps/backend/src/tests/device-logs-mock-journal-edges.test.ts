import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import * as logging from "../helpers/logger.ts";
import * as bootIdentity from "../modules/device-logs/boot-id.ts";
import { compileFilter } from "../modules/device-logs/filter.ts";
import {
	followMockJournal,
	scanMockJournal,
} from "../modules/device-logs/mock-journal.ts";
import { scanInput } from "./helpers/device-journal.ts";

afterEach(() => {
	setSystemTime();
	logging.clearRecentLogLines();
});
const emit = (message: string, level: string) =>
	new Promise<void>((resolve, reject) =>
		logging.logger.write({ message, level }, (error) =>
			error ? reject(error) : resolve(),
		),
	);

test.each(["error", "warn", "info", "debug"] as const)(
	"compiled severity uses native mock priority for %s",
	async (level) => {
		logging.clearRecentLogLines();
		for (const severity of ["error", "warn", "info", "debug"])
			await emit(severity, severity);
		const { matches } = compileFilter(
			{ levels: [level === "warn" ? "warning" : level] },
			{ bootId: null },
		);
		const messages: string[] = [];
		await scanMockJournal({
			...scanInput,
			matches,
			onRecord(record) {
				messages.push(record.message);
				return "continue";
			},
		});
		expect(messages).toEqual([level]);
	},
);

test("mock timestamps exactly preserve logger milliseconds", async () => {
	logging.clearRecentLogLines();
	setSystemTime(new Date(1700000000123));
	await emit("clock", "debug");
	let ts = 0;
	await scanMockJournal({
		...scanInput,
		onRecord(record) {
			ts = record.ts;
			return "continue";
		},
	});
	expect(ts).toBe(1700000000123);
});

test("unknown boot is counted as malformed instead of invented", async () => {
	logging.clearRecentLogLines();
	await emit("boot", "debug");
	const boot = spyOn(bootIdentity, "currentBootId").mockReturnValue(undefined);
	try {
		const result = await scanMockJournal({
			...scanInput,
			onRecord() {
				throw new Error("unknown boot was delivered");
			},
		});
		expect(result).toMatchObject({ status: "eof", skippedRecords: 1 });
	} finally {
		boot.mockRestore();
	}
});

function ringPort(names: string[]) {
	const line = (name: string) =>
		logging.formatProdEntry({
			message: name,
			level: "debug",
			timestamp: 1700000000000,
		});
	let listener: ((line: string, seq: number) => void) | undefined;
	let removed = 0;
	const recent = spyOn(logging, "getRecentLogLines").mockReturnValue(
		names.map(line),
	);
	const offset = spyOn(logging, "getLogRingOffset").mockReturnValue(0);
	const subscribe = spyOn(logging, "onLogLine").mockImplementation((next) => {
		listener = next;
		return () => {
			removed++;
		};
	});
	return {
		append(name: string, seq: number) {
			listener?.(line(name), seq);
		},
		removed: () => removed,
		restore() {
			recent.mockRestore();
			offset.mockRestore();
			subscribe.mockRestore();
		},
	};
}

test("reentrant append follows the entire pending snapshot in journal order", async () => {
	const port = ringPort(["one", "two"]);
	const messages: string[] = [];
	try {
		const handle = followMockJournal({
			...scanInput,
			onRecord(record) {
				messages.push(record.message);
				if (record.cursor === "mock=0") port.append("three", 2);
				return "continue";
			},
		});
		handle.abort();
		handle.abort();
		expect(await handle.exited).toBe(0);
		expect(messages).toEqual(["one", "two", "three"]);
		expect(port.removed()).toBe(1);
	} finally {
		port.restore();
	}
});

test.each([1000, 1001])(
	"reentrant pending queue boundary of %d is bounded",
	async (count) => {
		const port = ringPort(["one"]);
		let seen = 0;
		try {
			const handle = followMockJournal({
				...scanInput,
				onRecord(record) {
					seen++;
					if (record.cursor === "mock=0")
						for (let i = 1; i <= count; i++) port.append("live", i);
					return "continue";
				},
			});
			if (count === 1001) {
				await expect(handle.exited).rejects.toMatchObject({
					code: "READ_FAILED",
				});
				expect(seen).toBe(1);
			} else {
				handle.abort();
				expect(await handle.exited).toBe(0);
				expect(seen).toBe(1001);
			}
			expect(port.removed()).toBe(1);
		} finally {
			port.restore();
		}
	},
);

test("already aborted follow delivers neither backlog nor future entries", async () => {
	const port = ringPort(["backlog"]);
	const controller = new AbortController();
	controller.abort();
	try {
		const handle = followMockJournal({
			...scanInput,
			signal: controller.signal,
			onRecord() {
				throw new Error("aborted follow delivered");
			},
		});
		port.append("live", 1);
		expect(await handle.exited).toBe(0);
		expect(port.removed()).toBe(0);
	} finally {
		port.restore();
	}
});

test("a backlog callback failure rejects and releases the subscription", async () => {
	logging.clearRecentLogLines();
	await emit("backlog", "debug");
	const failure = new Error("backlog consumer");
	const handle = followMockJournal({
		...scanInput,
		onRecord() {
			throw failure;
		},
	});
	await expect(handle.exited).rejects.toBe(failure);
	handle.abort();
});

test("follow removes its abort listener from the same event it registered", async () => {
	const controller = new AbortController();
	const add = spyOn(controller.signal, "addEventListener");
	const remove = spyOn(controller.signal, "removeEventListener");
	try {
		const handle = followMockJournal({
			...scanInput,
			signal: controller.signal,
		});
		handle.abort();
		expect(await handle.exited).toBe(0);
		expect(remove.mock.calls[0]?.[0]).toBe("abort");
		expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
	} finally {
		add.mockRestore();
		remove.mockRestore();
	}
});
