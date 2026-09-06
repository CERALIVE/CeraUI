import { describe, expect, test } from "bun:test";
import {
	mppBlockForDevice,
	parseMppLoadRows,
	parseMppSessions,
	parseRgaLoad,
} from "../modules/system/encoder-load-proc.ts";

describe("procfs telemetry boundary", () => {
	test("keeps a duplicate core unavailable instead of double-counting it", () => {
		const rows = parseMppLoadRows(
			"1000.rkvenc-core load: 1.00% utilization: 2.00%\n1000.rkvenc-core load: 3.00% utilization: 4.00%\n",
		);
		expect(rows).toEqual([
			{ core: "1000.rkvenc-core", load: null, utilization: null },
		]);
	});
	test("sorts variable-width addresses numerically", () => {
		const rows = parseMppLoadRows(
			"1000.jpegd load: 1.00% utilization: 0.00%\nfff.jpegd load: 2.00% utilization: 1.00%\n",
		);
		expect(rows.map((row) => row.core)).toEqual(["fff.jpegd", "1000.jpegd"]);
	});
	test("refuses partial metric tokens while keeping the other metric", () => {
		expect(
			parseMppLoadRows("1000.jpegd load: 12%junk utilization: 3.00%\n"),
		).toEqual([{ core: "1000.jpegd", load: null, utilization: 3 }]);
	});
	test("never permits a procfs name to escape the sysfs device directory", () => {
		expect(
			parseMppLoadRows("../shadow load: 1.00% utilization: 2.00%\n"),
		).toEqual([]);
		expect(
			mppBlockForDevice("../shadow", "rockchip,rkv-decoder-v2\0"),
		).toBeNull();
	});
	test("distinguishes empty ownership from an unreadable grammar", () => {
		expect(parseMppSessions("\n")).toEqual(new Map());
		expect(parseMppSessions("new-format owners=0\n")).toBeNull();
	});
	test.each([
		"session: pid=bad index=1\n device: 1000.jpegd\n memory: 0 MiB\n",
		"session: pid=1 index=1\n device: ../shadow\n memory: 0 MiB\n",
		"session: pid=1 index=1\n device: 1000.jpegd\n",
		"session: pid=1 index=1\n device: 1000.jpegd\n memory: 0 MiB\nsession: pid=1 index=1\n device: 2000.jpegd\n memory: 0 MiB\n",
	])("withholds incomplete, malformed, or ambiguous ownership", (text) => {
		expect(parseMppSessions(text)).toBeNull();
	});
	test("does not pad an incomplete RGA scheduler dump", () => {
		expect(
			parseRgaLoad("num of scheduler = 2\nscheduler[0]: rga3\n\t load = 1%\n"),
		).toEqual([]);
	});
	test("does not collapse identically named RGA schedulers", () => {
		expect(
			parseRgaLoad(
				"num of scheduler = 2\nscheduler[1]: rga3\n\t load = 2%\nscheduler[0]: rga3\n\t load = 1%\n",
			).map((core) => core.core),
		).toEqual(["scheduler[0]: rga3", "scheduler[1]: rga3"]);
	});
	test("ignores the RGA global process table rather than inventing per-core owners", () => {
		const text =
			"num of scheduler = 1\nscheduler[0]: rga3\n\t load = 1%\n<session>  <status>  <tgid>  <rga2-stage-bytes>  <process>\n2 active 4242 0 scheduler[1]: rga3\n";
		expect(parseRgaLoad(text)).toEqual([
			{
				core: "scheduler[0]: rga3",
				load: 1,
				utilization: null,
				sessions: null,
			},
		]);
	});
});
