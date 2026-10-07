import { expect } from "bun:test";
import { setDefaultRoute } from "../../modules/network/default-route.ts";
import { kernelRouteRunner as runner } from "./default-route-kernel.ts";

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
