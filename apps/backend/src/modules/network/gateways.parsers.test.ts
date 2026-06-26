/*
 * S2 hardening — fail-loud `ip route` line parser.
 *
 * Happy path (well-formed default route) AND malformed inputs (empty / no
 * default / no via|dev), plus the setDefaultRoute fail-loud path: a garbled
 * route line is logged and throws instead of installing a meaningless route.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";

import { logger } from "../../helpers/logger.ts";
import { isParseError } from "../system/cli-parse.ts";
import { parseDefaultRouteLine, setDefaultRoute } from "./gateways.ts";

afterEach(() => {
	mock.restore();
});

describe("parseDefaultRouteLine", () => {
	it("tokenizes a well-formed default route into an add argv", () => {
		const r = parseDefaultRouteLine("default via 192.168.1.1 dev eth0\n");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value).toEqual([
				"route",
				"add",
				"default",
				"via",
				"192.168.1.1",
				"dev",
				"eth0",
			]);
		}
	});

	it("fails loud on an empty route line (drift)", () => {
		const r = parseDefaultRouteLine("");
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("does not start with 'default'");
	});

	it("fails loud when the line does not start with default", () => {
		const r = parseDefaultRouteLine("blackhole 10.0.0.0/8\n");
		expect(isParseError(r)).toBe(true);
	});

	it("fails loud when there is neither a via nor a dev clause", () => {
		const r = parseDefaultRouteLine("default\n");
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("'via'");
	});
});

describe("setDefaultRoute — fail-loud on a garbled route line", () => {
	it("logs the drift and throws instead of installing a bogus route", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const calls: Array<[string, string[]]> = [];
		const runner = mock(async (bin: string, args: string[]) => {
			calls.push([bin, args]);
			// The `show` returns junk; nothing valid to add.
			return args[1] === "show" ? "no default route here\n" : "";
		});

		await expect(
			setDefaultRoute("wwan0", {
				runner: runner as never,
				clearDefaultGws: async () => {},
			}),
		).rejects.toThrow("setDefaultRoute");

		// Never issued an `ip route add` with the garbled line.
		expect(calls.some((c) => c[1][1] === "add")).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
