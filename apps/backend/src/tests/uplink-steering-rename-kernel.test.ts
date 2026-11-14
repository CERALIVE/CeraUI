import { expect, test } from "bun:test";
import { run, runWithStdin } from "../helpers/run.ts";
import {
	type PreparedSteeringState,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	hasFwmarkRule,
	planUplinkRoute,
	removeUplinkRoute,
	rollbackUplinkRoute,
} from "../modules/network/uplink-steering/route-manager.ts";
import {
	inNamespace,
	isKernelChild,
	kernelReceipt,
	preflight,
} from "./helpers/kernel-namespace.ts";
import suites from "./kernel-suites.json";
import { uplink } from "./uplink-steering-test-fixtures.ts";

const file = import.meta.filename;
const child = isKernelChild(file);
const probe = child ? { ok: true, detail: "" } : await preflight();
const receipts: string[] = [];

const cases = [
	{
		name: "rename retains table, fwmark rule and marked lookup",
		kind: "rename",
	},
	{
		name: "rename retains support after final-publication failure",
		kind: "rename-final",
	},
	{ name: "rebinding retains support on another netdev", kind: "rebind" },
	{
		name: "rebinding final-publication failure restores the old netdev",
		kind: "rebind-final",
	},
	{
		name: "rename transition-publication failure retains support",
		kind: "transition",
	},
	{
		name: "departing identity still flushes and retires support",
		kind: "depart",
	},
] as const;

async function state(ifname: string): Promise<PreparedSteeringState> {
	const owner = uplink("rename-owner", ifname, 100);
	const route = await planUplinkRoute({
		...owner,
		sourceAddress: "100.64.1.2",
		sourceAddressUnique: false,
	});
	return {
		clientZones: [{ ifname: "eth9", ipv4Cidr: "10.90.0.0/24" }],
		uplinks: [owner],
		routes: [route],
	};
}

for (const { name, kind } of cases) {
	test(name, async () => {
		expect(probe.ok, probe.detail).toBe(true);
		if (!child) {
			await inNamespace(file, name);
			receipts.push(name);
			return;
		}
		for (const iface of ["wwan1", "wwan2"]) {
			await run("ip", ["link", "add", iface, "type", "dummy"]);
			await run("ip", ["link", "set", iface, "up"]);
			await run("ip", ["addr", "add", "100.64.1.2/24", "dev", iface]);
			await run("ip", [
				"route",
				"add",
				"default",
				"via",
				"100.64.1.1",
				"dev",
				iface,
				"metric",
				iface === "wwan1" ? "100" : "150",
			]);
		}
		const flushed: number[] = [];
		const reset: string[] = [];
		let failure: "final" | "transition" | undefined;
		let injected = 0;
		const applier = new UplinkSteeringApplier({
			discoverRoutes: discoverOwnedUplinkRoutes,
			ensureRoute: ensureUplinkRoute,
			rollbackRoute: rollbackUplinkRoute,
			removeRoute: removeUplinkRoute,
			applyRuleset: async (ruleset) => {
				const final = !ruleset.includes(
					`oifname "${kind === "transition" ? "wwan2" : "wwan1"}"`,
				);
				if (
					failure !== undefined &&
					(final ? failure === "final" : failure === "transition")
				) {
					injected++;
					const boundary = failure;
					failure = undefined;
					throw new Error(`injected ${boundary}-publication failure`);
				}
				await runWithStdin("nft", ["-f", "-"], ruleset);
			},
			deactivateSharing: async () => {
				await run("nft", ["delete", "table", "inet", "ceralive_share"]);
			},
			flushConntrack: async (mark) => {
				flushed.push(mark);
			},
			setIpForwarding: async () => {},
			publishFlowsReset: (event) => {
				reset.push(event.iface);
			},
		});
		let previous = await state("wwan1");
		await applier.apply(undefined, previous);
		const [route] = previous.routes;
		if (route === undefined) throw new Error("missing initial route");
		const before = await run("ip", ["route", "show", "table", route.table]);
		const beforeRules = await run("ip", ["rule", "show"]);

		// A departing second identity forces a real transition even after rename retention.
		if (kind === "transition") {
			const departing = uplink("departing-owner", "wwan2", 100);
			const departingRoute = await planUplinkRoute({
				...departing,
				sourceAddress: "100.64.1.2",
				sourceAddressUnique: false,
			});
			const expanded = {
				...previous,
				uplinks: [...previous.uplinks, departing],
				routes: [...previous.routes, departingRoute],
			};
			await applier.apply(previous, expanded);
			previous = expanded;
		}
		const rebind = kind === "rebind" || kind === "rebind-final";
		if (!rebind && kind !== "depart") {
			await run("ip", ["link", "set", "wwan1", "name", "wwan3"]);
		}
		const next =
			kind === "depart"
				? { ...previous, uplinks: [], routes: [] }
				: await state(rebind ? "wwan2" : "wwan3");
		failure =
			kind === "rename-final" || kind === "rebind-final"
				? "final"
				: kind === "transition"
					? "transition"
					: undefined;
		const expectedFailure = failure;
		const error: unknown = await applier.apply(previous, next).then(
			() => undefined,
			(error: unknown) => error,
		);
		if (expectedFailure !== undefined) {
			expect(injected).toBe(1);
			expect(error).toBeInstanceOf(Error);
			expect(error instanceof Error ? error.message : "").toContain(
				`injected ${expectedFailure}-publication failure`,
			);
		} else {
			expect(error).toBeUndefined();
		}
		const after = await run("ip", ["route", "show", "table", route.table]);
		const rules = await run("ip", ["rule", "show"]);
		if (kind === "depart") {
			expect(after).toBe("");
			expect(hasFwmarkRule(rules, route)).toBe(false);
			expect(flushed).toEqual([route.mark]);
			expect(reset).toEqual(["wwan1"]);
		} else {
			const iface =
				kind === "rebind-final" ? "wwan1" : rebind ? "wwan2" : "wwan3";
			expect(after.trim().split("\n")).toHaveLength(1);
			expect(after).toContain(`default via 100.64.1.1 dev ${iface}`);
			expect(hasFwmarkRule(rules, route)).toBe(true);
			const lookup = await run("ip", [
				"route",
				"get",
				"203.0.113.1",
				"mark",
				`0x${route.mark.toString(16)}`,
			]);
			expect(lookup).toContain(`dev ${iface}`);
			expect(lookup).toContain(`table ${route.table}`);
			expect(flushed).toEqual([]);
			expect(reset).toEqual([]);
			if (kind === "rebind-final") {
				expect(after).toBe(before);
				expect(rules).toBe(beforeRules);
			}
		}
		console.log(kernelReceipt(file, name));
	}, 30_000);
}

if (!child) {
	test("kernel scenario receipt set", () => {
		expect(probe.ok, probe.detail).toBe(true);
		expect([...receipts].sort()).toEqual(
			[...suites["uplink-steering-rename-kernel.test.ts"]].sort(),
		);
	});
}
