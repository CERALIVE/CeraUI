import { expect, test } from "bun:test";
import { matchesResidual } from "../modules/device-logs/residual.ts";
import { record } from "./helpers/device-query.ts";

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
