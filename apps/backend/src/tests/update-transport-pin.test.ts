import { describe, expect, test } from "bun:test";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import {
	CLIENT_FLOW_NAMESPACE,
	FWMARK_RULE_PRIORITY,
} from "../modules/network/uplink-steering/contracts.ts";
import {
	isManagedUplinkTable,
	planUplinkRoute,
} from "../modules/network/uplink-steering/route-planner.ts";
import {
	rankTransports,
	type TransportSample,
} from "../modules/system/update-transport/core.ts";
import {
	createUpdatePinController,
	UPDATE_TRANSPORT_RULE_PRIORITY,
	UPDATE_TRANSPORT_TABLE_BASE,
	UpdateTransferError,
} from "../modules/system/update-transport/pin.ts";

const capabilities = updateCapabilityFileSchema.parse({
	schema: 1,
	features: ["apt-all-packages", "transport-uidrange"],
	apt_uid: 42042,
	ota_uid: 42043,
});
const samples: TransportSample[] = ["eth0", "eth1", "eth2", "eth3"].map(
	(ifname) => ({
		candidate: { ifname, kind: "ethernet", metered: false },
		family: 4,
		hosts: [
			{ host: "fixture", state: "clear", latencyMs: Number(ifname.slice(-1)) },
		],
	}),
);
const selection = rankTransports(samples);

describe("per-transaction update routing", () => {
	test("both update tables are disjoint from the real steering planner's whole mark space", async () => {
		// Given the production steering namespace, when deriving its last managed table.
		const mark = CLIENT_FLOW_NAMESPACE | (0xffff << 8);
		const plan = await planUplinkRoute(
			{
				identity: "test",
				ifname: "eth0",
				sourceAddress: "192.0.2.1",
				sourceAddressUnique: false,
				mark: mark >>> 0,
			},
			{
				run: async (_bin, args) =>
					args.join(" ").includes("rule show")
						? "0: from all lookup local\n"
						: "default via 192.0.2.2 dev eth0\n",
			},
		);
		// Then the update tables cannot overlap any table computed in that space.
		expect(isManagedUplinkTable(plan.table)).toBe(true);
		for (const table of [
			UPDATE_TRANSPORT_TABLE_BASE,
			UPDATE_TRANSPORT_TABLE_BASE + 1,
		]) {
			expect(table).toBeGreaterThan(Number(plan.table));
			expect(isManagedUplinkTable(String(table))).toBe(false);
		}
		expect(UPDATE_TRANSPORT_RULE_PRIORITY).toBeGreaterThan(
			FWMARK_RULE_PRIORITY,
		);
	});

	test("pins only the chosen UID and family; finally removes rules after a throwing step", async () => {
		// Given a valid image UID and an eth0 default, when the APT step throws.
		const calls: string[] = [];
		const controller = createUpdatePinController({
			readCapabilities: async () => capabilities,
			run: async (_bin, args) => {
				calls.push(args.join(" "));
				if (args.join(" ") === "route show default")
					return "default via 192.0.2.2 dev eth0\n";
				if (args.join(" ") === "-6 route show default") return "";
				return "";
			},
		});
		await controller.sweep();
		await expect(
			controller.run("apt", selection, async (_candidate, flags) => {
				expect(flags).toEqual(["-o", "Acquire::ForceIPv4=true"]);
				throw new Error("application failure");
			}),
		).rejects.toThrow("application failure");
		// Then both rules and the private table are torn down, not the main table.
		expect(calls).toContain(
			`rule add priority 120 uidrange 42042-42042 lookup ${UPDATE_TRANSPORT_TABLE_BASE}`,
		);
		expect(calls).toContain(
			"-6 rule add priority 120 uidrange 42042-42042 prohibit",
		);
		expect(calls).toContain(
			"-6 rule del priority 120 uidrange 42042-42042 prohibit",
		);
		expect(calls).toContain(`route flush table ${UPDATE_TRANSPORT_TABLE_BASE}`);
		expect(
			calls.some(
				(line) =>
					line.includes("route del default") ||
					line.includes("route flush table main"),
			),
		).toBe(false);
	});

	test("fails over exact pairs for 15 minutes and never attempts a fourth candidate", async () => {
		// Given four ranked clear links, when each attempted transfer times out.
		let now = 1_000;
		const attempts: string[] = [];
		const controller = createUpdatePinController({
			readCapabilities: async () => capabilities,
			now: () => now,
			run: async (_bin, args) =>
				args.join(" ").endsWith("route show default")
					? "default via 192.0.2.2 dev eth0\ndefault via 198.51.100.2 dev eth1\ndefault via 203.0.113.2 dev eth2\ndefault dev eth3\n"
					: "",
		});
		await controller.sweep();
		await expect(
			controller.run("os", selection, async ({ candidate }) => {
				attempts.push(candidate.ifname);
				throw new UpdateTransferError("blocked");
			}),
		).rejects.toBeInstanceOf(UpdateTransferError);
		expect(attempts).toEqual(["eth0", "eth1", "eth2"]);
		expect(controller.unhealthyUntil("eth0", 4)).toBe(now + 15 * 60_000);
		expect(controller.unhealthyUntil("eth0", 6)).toBeUndefined();
		attempts.length = 0;
		await controller.run("os", selection, async ({ candidate }) => {
			attempts.push(candidate.ifname);
			return "ok";
		});
		expect(attempts).toEqual(["eth3"]);
		now += 15 * 60_000;
		attempts.length = 0;
		await controller.run("os", selection, async ({ candidate }) => {
			attempts.push(candidate.ifname);
			return "ok";
		});
		expect(attempts).toEqual(["eth0"]);
	});
});
