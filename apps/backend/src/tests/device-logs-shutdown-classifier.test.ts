import { expect, test } from "bun:test";
import type { DeviceEvent } from "@ceraui/rpc/schemas";
import { classifyBoot } from "../modules/device-logs/shutdown-classifier.ts";
import { record } from "./helpers/device-query.ts";

const stopped = "d93fb3c9c24d451a97cea615ce59c00b";
const started = "f77379a8490b408bbe5f6940505a777b";
const ordinary = (count: number) =>
	Array.from({ length: count }, (_, n) => record(n));
const request: DeviceEvent = {
	id: "request",
	seq: 1,
	bootId: "a".repeat(32),
	at: 1,
	code: "shutdown_requested",
	family: "device",
	severity: "info",
	params: {},
};
const input = () => ({
	isCurrent: false,
	tail: ordinary(20),
	nextBootHead: [],
	storeEvents: [],
});

test("current takes precedence over all shutdown evidence", () => {
	expect(
		classifyBoot({
			...input(),
			isCurrent: true,
			tail: [record(1, { MESSAGE_ID: stopped })],
		}),
	).toEqual({ shutdown: "current", evidence: [] });
});

test.each([
	"shutdown.target",
	"reboot.target",
	"poweroff.target",
	"final.target",
])("PID 1 reaching %s proves clean even before later evidence", (target) => {
	expect(
		classifyBoot({
			...input(),
			tail: [record(1, { _PID: "1", UNIT: target })],
			nextBootHead: [
				record(2, {
					_SYSTEMD_UNIT: "systemd-journald.service",
					MESSAGE: "corrupted",
				}),
			],
			storeEvents: [request],
		}),
	).toEqual({ shutdown: "clean", evidence: ["shutdown_target"] });
});

test.each([
	{ _PID: "2", UNIT: "shutdown.target" },
	{ UNIT: "shutdown.target" },
	{ _PID: "1", UNIT: "shutdown.target.extra" },
	{ _PID: "1", UNIT: "other.target" },
	{ _PID: "1" },
])("only PID 1 and an exact shutdown target prove clean: %j", (fields) => {
	expect(classifyBoot({ ...input(), tail: [record(1, fields)] })).toEqual({
		shutdown: "unknown",
		evidence: ["too_few_entries"],
	});
});

test("the last lifecycle stop proves clean regardless of later ordinary records", () => {
	// Tail is newest first, exactly as the reverse reader delivers it.
	expect(
		classifyBoot({
			...input(),
			tail: [
				record(4),
				record(3, { MESSAGE_ID: stopped }),
				record(2, { MESSAGE_ID: started }),
				record(1, { MESSAGE_ID: stopped }),
			],
			nextBootHead: [
				record(5, {
					_SYSTEMD_UNIT: "systemd-journald.service",
					MESSAGE: "uncleanly shut down",
				}),
			],
		}),
	).toEqual({ shutdown: "clean", evidence: ["journal_stopped"] });
});

test("restart followed by a power cut is unclean despite an earlier stop", () => {
	expect(
		classifyBoot({
			...input(),
			tail: [
				...ordinary(18),
				record(2, { MESSAGE_ID: started }),
				record(1, { MESSAGE_ID: stopped }),
			],
		}),
	).toEqual({ shutdown: "unclean", evidence: ["no_shutdown_markers"] });
});

test("a PID 1 shutdown target anywhere in the tail outranks a later journal start", () => {
	expect(
		classifyBoot({
			...input(),
			tail: [
				record(3, { MESSAGE_ID: started }),
				record(2),
				record(1, { _PID: "1", UNIT: "shutdown.target" }),
			],
		}),
	).toEqual({ shutdown: "clean", evidence: ["shutdown_target"] });
});

test.each(["uncleanly shut down", "corrupted"])(
	"next boot journald %s evidence outranks missing or short tails",
	(message) => {
		expect(
			classifyBoot({
				...input(),
				tail: [],
				nextBootHead: [
					record(1, {
						_SYSTEMD_UNIT: "systemd-journald.service",
						MESSAGE: `File /journal was ${message}, replacing.`,
					}),
				],
			}),
		).toEqual({
			shutdown: "unclean",
			evidence: ["next_boot_unclean_journal"],
		});
	},
);

test.each([
	{ _SYSTEMD_UNIT: "ceralive.service", MESSAGE: "corrupted" },
	{ _SYSTEMD_UNIT: "systemd-journald-extra.service", MESSAGE: "corrupted" },
	{ _SYSTEMD_UNIT: "systemd-journald.service", MESSAGE: "cleanly shut down" },
])(
	"other next-boot messages do not prove an unclean shutdown: %j",
	(fields) => {
		expect(
			classifyBoot({ ...input(), tail: [], nextBootHead: [record(1, fields)] }),
		).toEqual({ shutdown: "unknown", evidence: ["no_entries"] });
	},
);

test.each([20, 21, 100])(
	"%i records without clean markers prove unclean",
	(count) => {
		expect(classifyBoot({ ...input(), tail: ordinary(count) })).toEqual({
			shutdown: "unclean",
			evidence: ["no_shutdown_markers"],
		});
	},
);

test.each([1, 5, 19])(
	"%i records without markers stay unknown even with a request event",
	(count) => {
		expect(
			classifyBoot({
				...input(),
				tail: ordinary(count),
				storeEvents: [request],
			}),
		).toEqual({ shutdown: "unknown", evidence: ["too_few_entries"] });
	},
);

test("no records stay unknown even when the store recorded shutdown intent", () => {
	expect(
		classifyBoot({ ...input(), tail: [], storeEvents: [request] }),
	).toEqual({ shutdown: "unknown", evidence: ["no_entries"] });
});

test("a shutdown request is intent, never a clean shutdown receipt", () => {
	expect(classifyBoot({ ...input(), storeEvents: [request] })).toEqual({
		shutdown: "unclean",
		evidence: ["no_shutdown_markers", "shutdown_requested_event"],
	});
});

test("service stopping alone does not claim a shutdown request", () => {
	expect(
		classifyBoot({
			...input(),
			storeEvents: [{ ...request, code: "service_stopping" }],
		}),
	).toEqual({ shutdown: "unclean", evidence: ["no_shutdown_markers"] });
});
