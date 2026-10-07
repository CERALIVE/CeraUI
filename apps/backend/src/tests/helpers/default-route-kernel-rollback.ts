/// <reference lib="es2022" />
import { expect } from "bun:test";
import type { run } from "../../helpers/run.ts";
import { setDefaultRoute } from "../../modules/network/default-route.ts";
import { GatewayRouteError } from "../../modules/network/default-route-model.ts";
import { kernelRouteRunner as runner } from "./default-route-kernel.ts";
import { runTestCommand } from "./run-test-command.ts";

const FOREIGN = "default via 192.0.2.1 dev routea proto 16";

async function acquireFloor(): Promise<void> {
	await runner("ip", ["route", "add", ...FOREIGN.split(" ")]);
	await runner("ip", [
		"route",
		"add",
		..."default via 198.51.100.1 dev routeb proto 16 metric 83".split(" "),
	]);
	await setDefaultRoute("routeb", { runner });
}

async function renewForeign(): Promise<void> {
	await runner("ip", ["route", "del", ...FOREIGN.split(" ")]);
	await runner("ip", ["route", "prepend", ...FOREIGN.split(" ")]);
}

export const rollbackKernelScenarios: Readonly<
	Record<string, () => Promise<void>>
> = {
	"RT4-M1 untied IPv4 undo preserves ordered tables after real IPv6 EPERM":
		async () => {
			// Given: the old preference is sole at priority 49 before a third NIC is elected.
			await runner("ip", ["link", "add", "routec", "type", "dummy"]);
			await runner("ip", ["link", "set", "routec", "up"]);
			await runner("ip", ["addr", "add", "198.18.0.2/24", "dev", "routec"]);
			for (const row of [
				"default via 192.0.2.1 dev routea proto 16 metric 50",
				"default via 198.51.100.1 dev routeb proto 16 metric 702",
				"default via 198.18.0.1 dev routec proto 16 metric 703",
			])
				await runner("ip", ["route", "add", ...row.split(" ")]);
			await setDefaultRoute("routeb", { runner });
			await runner("ip", [
				"-6",
				"route",
				"add",
				..."default via fe80::2 dev routeb proto 242 metric 7".split(" "),
			]);
			const dump = (family: 4 | 6) =>
				runner("ip", [`-${family}`, "-N", "route", "show", "table", "all"]);
			const fib = () =>
				runner("ip", ["-N", "route", "get", "8.8.8.8", "fibmatch"]);
			const before = [await dump(4), await dump(6)];
			const beforeFib = await fib();
			expect(beforeFib).toMatch(/dev routeb proto 242 metric 49\b/);
			const fault: typeof run = async (bin, args, opts) => {
				if (args.includes("-6") && args.includes("del")) {
					expect(await fib()).toMatch(/dev routec proto 242 metric 49\b/);
					expect(await dump(4)).not.toMatch(/dev routeb proto 242 metric 49\b/);
					const result = await runTestCommand(["unshare", "-Ur", bin, ...args]);
					expect(result.code).toBe(2);
					expect(result.stderr).toMatch(
						/^RTNETLINK answers: Operation not permitted/,
					);
					throw new Error(result.stderr);
				}
				return runner(bin, args, opts);
			};
			// When: the unchanged IPv6 delete argv runs without privilege in its owning namespace.
			const error: unknown = await setDefaultRoute("routec", {
				runner: fault,
			}).catch((cause: unknown) => cause);
			// Then: only the injected EPERM remains; undo preserves full ordered tables and winner.
			expect(error).toBeInstanceOf(GatewayRouteError);
			if (
				!(error instanceof GatewayRouteError) ||
				!(error.cause instanceof AggregateError)
			)
				throw new Error("aggregate missing");
			expect(error.cause.errors).toHaveLength(1);
			expect(error.cause.errors[0]).toMatchObject({
				message: expect.stringContaining(
					"RTNETLINK answers: Operation not permitted",
				),
			});
			expect([await dump(4), await dump(6)]).toEqual(before);
			expect(await fib()).toBe(beforeFib);
		},
	"RT2-M1 rejected election preserves ordered FIB": async () => {
		// Given: renewal overtook the old preference before a third NIC is elected.
		await acquireFloor();
		await renewForeign();
		await runner("ip", [
			"route",
			"append",
			"default",
			"dev",
			"routea",
			"proto",
			"17",
			"metric",
			"0",
		]);
		await runner("ip", ["link", "add", "routec", "type", "dummy"]);
		await runner("ip", ["link", "set", "routec", "up"]);
		await runner("ip", ["addr", "add", "203.0.113.2/24", "dev", "routec"]);
		await runner("ip", [
			"route",
			"add",
			..."default via 203.0.113.1 dev routec proto 16 metric 100".split(" "),
		]);
		await runner("ip", ["route", "add", "203.0.113.254/32", "dev", "routea"]);
		const beforeFib = await runner("ip", [
			"route",
			"get",
			"8.8.8.8",
			"fibmatch",
		]);
		const before = await runner("ip", ["-4", "route", "show", "table", "all"]);
		expect(beforeFib).toMatch(/dev routea proto dhcp\b/);
		// When: the more-specific verification route rejects the new preference.
		await expect(setDefaultRoute("routec", { runner })).rejects.toMatchObject({
			reason: "apply-failed",
		});
		// Then: both the winner and full ordered IPv4 table are byte-identical.
		const afterFib = await runner("ip", [
			"route",
			"get",
			"8.8.8.8",
			"fibmatch",
		]);
		const after = await runner("ip", ["-4", "route", "show", "table", "all"]);
		expect(afterFib).toBe(beforeFib);
		expect(after).toBe(before);
	},
	"RT2-M2 policy table cannot prove main preference": async () => {
		// Given: an owned-looking copy outside main intercepts only the proof destination.
		await acquireFloor();
		const row = (await runner("ip", ["-N", "route", "show", "default"]))
			.trim()
			.split("\n")
			.find((line) => /\bproto 242\b/.test(line));
		if (!row) throw new Error("owned copy missing");
		const copy = row.trim().split(/\s+/);
		await runner("ip", ["route", "add", ...copy, "table", "100001"]);
		await runner("ip", [
			"rule",
			"add",
			"priority",
			"120",
			"to",
			"203.0.113.254/32",
			"lookup",
			"100001",
		]);
		await renewForeign();
		const beforeFib = await runner("ip", [
			"route",
			"get",
			"8.8.8.8",
			"fibmatch",
		]);
		const before = await runner("ip", ["-4", "route", "show", "table", "all"]);
		expect(
			await runner("ip", ["-N", "route", "get", "203.0.113.254", "fibmatch"]),
		).toContain("table 100001");
		expect(beforeFib).toMatch(/dev routea proto dhcp\b/);
		// When: the matching main preference loses, and policy lookup must not retain it.
		await expect(setDefaultRoute("routeb", { runner })).rejects.toMatchObject({
			reason: "apply-failed",
		});
		// Then: refusal restores the ordered table, including the untouched policy copy.
		expect(await runner("ip", ["route", "get", "8.8.8.8", "fibmatch"])).toBe(
			beforeFib,
		);
		expect(await runner("ip", ["-4", "route", "show", "table", "all"])).toBe(
			before,
		);
	},
};
