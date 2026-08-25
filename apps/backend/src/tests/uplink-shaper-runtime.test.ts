import { afterEach, describe, expect, test } from "bun:test";
import { ShaperUnavailableError } from "../modules/network/uplink-shaper/contracts.ts";
import {
	getUplinkShaperStatus,
	publishShaperAvailable,
	publishShaperUnavailable,
	resetUplinkShaperStatusForTest,
} from "../modules/network/uplink-shaper/status.ts";
import {
	parseBacklogBytes,
	parseRootQdisc,
} from "../modules/network/uplink-shaper/tc-runtime.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

afterEach(resetUplinkShaperStatusForTest);

describe("uplink shaper runtime boundaries", () => {
	test("parses root ownership and client backlog from tc output", () => {
		expect(parseRootQdisc("qdisc prio ca00: root refcnt 2 bands 2\n")).toEqual({
			kind: "prio",
			handle: "ca00:",
		});
		expect(parseBacklogBytes(" backlog 32Kb 7p requeues 0\n")).toBe(32_000);
	});

	test("wire reports the active fallback algorithm and hydrates it", () => {
		publishShaperAvailable("streaming", "htb-fq_codel");
		expect(getUplinkShaperStatus()).toEqual({
			state: "available",
			mode: "streaming",
			algorithm: "htb-fq_codel",
		});
		expect(buildInitialStatus().uplinkShaper).toEqual(getUplinkShaperStatus());
	});

	test("tc failure reports honest priority degradation while sharing remains independent", () => {
		publishShaperUnavailable(
			new ShaperUnavailableError("tc_apply_failed", "tc refused"),
		);
		expect(getUplinkShaperStatus()).toEqual({
			state: "shaper_unavailable",
			reason: "tc_apply_failed",
			priorityDegraded: true,
			detail: "tc refused",
		});
	});
});
