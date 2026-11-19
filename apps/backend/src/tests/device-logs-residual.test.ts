import { expect, test } from "bun:test";
import type { LogSource } from "@ceraui/rpc/schemas";
import { parseRecord } from "../modules/device-logs/parse.ts";
import { matchesResidual } from "../modules/device-logs/residual.ts";
import { record } from "./helpers/device-query.ts";

test.each([
	["ceralive.service", "srtla_send: link ready", "bonding", false, true],
	[
		"ceralive.service",
		"app mentions srtla_send: link ready",
		"app",
		true,
		false,
	],
	["srtla.service", "receiver accepted a connection", "bonding", false, true],
	["NetworkManager.service", "srtla_send: quoted", "network", false, false],
] as const)(
	"%s message %s is attributed to %s and filtered accordingly",
	(unit, msg, source, inApp, inBonding) => {
		const entry = parseRecord({
			__CURSOR: "fixture=1",
			__REALTIME_TIMESTAMP: "1000",
			_BOOT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			_SYSTEMD_UNIT: unit,
			MESSAGE: JSON.stringify({ ts: "2026-01-01", msg, module: "fixture" }),
		});
		if (!entry) throw new Error("invalid journal fixture");
		const included = (sources: LogSource[]) =>
			matchesResidual(entry, { sources });
		expect([
			entry.source,
			included(["app"]),
			included(["bonding", "bonding"]),
		]).toEqual([source, inApp, inBonding]);
		expect(included(["app", "bonding"])).toBe(inApp || inBonding);
		expect(included([])).toBe(true);
	},
);

test("an omitted source selection keeps an unrelated suppression notice", () => {
	expect(
		matchesResidual(
			{ ...record(1), marker: "suppressed", message: "unknown unit dropped" },
			{},
		),
	).toBe(true);
});
test("a suppression notice naming any selected source survives the source union", () => {
	for (const message of [
		"ceralive.service dropped",
		"NetworkManager.service dropped",
	]) {
		expect(
			matchesResidual(
				{ ...record(1), marker: "suppressed", message },
				{ sources: ["app", "network", "kernel"] },
			),
		).toBe(true);
	}
});

test.each([
	[{ ts: 10 }, { since: 10, until: 10 }, true],
	[{ ts: 9 }, { since: 10 }, false],
	[{ ts: 11 }, { until: 10 }, false],
	[{ ts: 10 }, {}, true],
	[{ message: "USB.[*] FOUND" }, { text: "usb.[*]" }, true],
	[{ message: "USBx" }, { text: "usb." }, false],
	[{ message: "", marker: null }, {}, true],
	[
		{ message: "ceralive.service dropped", marker: "suppressed" },
		{ sources: ["app"] },
		true,
	],
	[
		{ message: "NetworkManager.service dropped", marker: "suppressed" },
		{ sources: ["app"] },
		false,
	],
	[{ message: "unknown dropped", marker: "suppressed" }, {}, true],
	[
		{ message: "NetworkManager.service dropped", marker: "suppressed" },
		{ sources: ["network"] },
		true,
	],
	[
		{ message: "unknown dropped", marker: "suppressed" },
		{ sources: ["kernel"] },
		false,
	],
] as const)(
	"residual membership %j against %j is %j",
	(patch, filter, expected) => {
		expect(
			matchesResidual(
				{ ...record(1), ...patch },
				{ ...filter, sources: "sources" in filter ? [...filter.sources] : [] },
			),
		).toBe(expected);
	},
);
