import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { run } from "../helpers/run.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	hasFwmarkRule,
	planUplinkRoute,
	removeUplinkRoute,
} from "../modules/network/uplink-steering/route-manager.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

const child = process.env.CERALIVE_STEERING_ROUTE_KERNEL_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;
const reason = `user/network namespace unavailable: ${probe?.stderr.trim()}`;
const name = "#433 provisions and retires never-created steering tables";

describe("real kernel steering route absence", () => {
	(unavailable ? test.skip : test)(
		unavailable ? `${name} (SKIP: ${reason})` : name,
		async () => {
			if (!child) {
				const result = await runTestCommand(
					[
						"unshare",
						"-Urn",
						process.execPath,
						"test",
						fileURLToPath(import.meta.url),
						"--test-name-pattern",
						name,
					],
					{ env: { CERALIVE_STEERING_ROUTE_KERNEL_CHILD: "1" } },
				);
				console.log(result.stdout + result.stderr);
				expect(result.code, result.stdout + result.stderr).toBe(0);
				return;
			}
			// Prove absence before any route or rule can create the managed table.
			await expect(
				run("ip", ["route", "show", "table", "30001"]),
			).rejects.toMatchObject({
				code: 2,
				stdout: "",
				stderr: "Error: ipv4: FIB table does not exist.\nDump terminated\n",
			});
			const flush = await runTestCommand([
				"ip",
				"route",
				"flush",
				"table",
				"30001",
			]);
			console.log("ABSENT_TABLE_FLUSH", JSON.stringify(flush));
			expect(flush).toEqual({
				code: 2,
				stdout: "",
				stderr: "Error: ipv4: FIB table does not exist.\nFlush terminated\n",
			});

			await run("ip", ["link", "add", "ww0", "type", "dummy"]);
			await run("ip", ["link", "set", "ww0", "up"]);
			await run("ip", ["addr", "add", "10.64.0.2/24", "dev", "ww0"]);
			await run("ip", [
				"route",
				"add",
				"default",
				"via",
				"10.64.0.1",
				"dev",
				"ww0",
			]);
			const plan = await planUplinkRoute({
				identity: "kernel-modem",
				ifname: "ww0",
				sourceAddress: "10.64.0.2",
				sourceAddressUnique: true,
				mark: 0xca000100,
			});
			await ensureUplinkRoute(plan);
			expect(await run("ip", ["route", "show", "table", plan.table])).toContain(
				"default via 10.64.0.1 dev ww0",
			);
			expect(hasFwmarkRule(await run("ip", ["rule", "show"]), plan)).toBe(true);

			await removeUplinkRoute(plan);
			expect(hasFwmarkRule(await run("ip", ["rule", "show"]), plan)).toBe(
				false,
			);
			expect(await run("ip", ["route", "show", "table", plan.table])).toBe("");

			// A rule may outlive a table that has never been instantiated.
			await run("ip", [
				"rule",
				"add",
				"priority",
				"110",
				"fwmark",
				"0xca000200/0xffffff00",
				"lookup",
				"30002",
			]);
			const recovered = await discoverOwnedUplinkRoutes();
			expect(recovered).toMatchObject([
				{
					table: "30002",
					mark: 0xca000200,
					ifname: "unknown0",
					managed: true,
				},
			]);
			const [orphan] = recovered;
			if (orphan === undefined) throw new Error("owned rule was not recovered");
			await removeUplinkRoute(orphan);
			expect(await discoverOwnedUplinkRoutes()).toEqual([]);
		},
		30_000,
	);
});
