import { describe, expect, test } from "bun:test";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import {
	createUpdatePinController,
	UPDATE_TRANSPORT_TABLE_BASE,
} from "../modules/system/update-transport/pin.ts";

const capabilities = updateCapabilityFileSchema.parse({
	schema: 1,
	features: ["apt-all-packages", "transport-uidrange"],
	apt_uid: 42042,
	ota_uid: 42043,
});
const selection = rankTransports([
	{
		candidate: { ifname: "eth0", kind: "ethernet", metered: false },
		family: 4,
		hosts: [{ host: "fixture", state: "clear", latencyMs: 1 }],
	},
]);

describe("update UID route safety", () => {
	test("startup sweep refuses foreign priority owners and cleans owned crash leftovers", async () => {
		const calls: string[] = [];
		const controller = createUpdatePinController({
			readCapabilities: async () => capabilities,
			run: async (_bin, args) => {
				calls.push(args.join(" "));
				if (args.join(" ") === "rule show")
					return `0: from all lookup local\n120: from all uidrange 42042-42042 lookup ${UPDATE_TRANSPORT_TABLE_BASE}\n`;
				if (args.join(" ") === "-6 rule show")
					return "120: from all uidrange 42042-42042 prohibit\n";
				return "";
			},
		});
		await controller.sweep();
		expect(calls).toContain(
			`rule del priority 120 uidrange 42042-42042 lookup ${UPDATE_TRANSPORT_TABLE_BASE}`,
		);
		expect(calls).toContain(
			"-6 rule del priority 120 uidrange 42042-42042 prohibit",
		);
		expect(calls).toContain(`route flush table ${UPDATE_TRANSPORT_TABLE_BASE}`);
		expect(calls).toContain(
			`-6 route flush table ${UPDATE_TRANSPORT_TABLE_BASE + 1}`,
		);
	});

	test("startup must sweep first; a foreign priority-120 rule prevents admission", async () => {
		const controller = createUpdatePinController({
			readCapabilities: async () => capabilities,
			run: async (_bin, args) =>
				args.join(" ") === "rule show"
					? "120: from all fwmark 0x1 lookup 99\n"
					: "",
		});
		await expect(
			controller.run("apt", selection, async () => "ran"),
		).rejects.toHaveProperty("reason", "sweep-required");
		await expect(controller.sweep()).rejects.toHaveProperty(
			"reason",
			"foreign-rule",
		);
		await expect(
			controller.run("apt", selection, async () => "ran"),
		).rejects.toHaveProperty("reason", "sweep-required");
	});

	test("partial rule installation still removes the prohibit rule and table", async () => {
		const calls: string[] = [];
		const controller = createUpdatePinController({
			readCapabilities: async () => capabilities,
			run: async (_bin, args) => {
				const line = args.join(" ");
				calls.push(line);
				if (line === "route show default") return "default dev eth0\n";
				if (
					line ===
					`rule add priority 120 uidrange 42042-42042 lookup ${UPDATE_TRANSPORT_TABLE_BASE}`
				)
					throw new Error("kernel rejected rule");
				return "";
			},
		});
		await controller.sweep();
		await expect(
			controller.run("apt", selection, async () => "never"),
		).rejects.toThrow("kernel rejected rule");
		expect(calls).toContain(
			"-6 rule del priority 120 uidrange 42042-42042 prohibit",
		);
		expect(calls).toContain(`route flush table ${UPDATE_TRANSPORT_TABLE_BASE}`);
	});

	test("a rule add that applies then loses its acknowledgement is still deleted", async () => {
		const calls: string[] = [];
		const controller = createUpdatePinController({
			readCapabilities: async () => capabilities,
			run: async (_bin, args) => {
				const line = args.join(" ");
				calls.push(line);
				if (line === "route show default") return "default dev eth0\n";
				if (
					line ===
					`rule add priority 120 uidrange 42042-42042 lookup ${UPDATE_TRANSPORT_TABLE_BASE}`
				)
					throw new Error("reply lost after kernel applied rule");
				return "";
			},
		});
		await controller.sweep();
		await expect(
			controller.run("apt", selection, async () => "never"),
		).rejects.toThrow("reply lost");
		expect(calls).toContain(
			`rule del priority 120 uidrange 42042-42042 lookup ${UPDATE_TRANSPORT_TABLE_BASE}`,
		);
	});

	test("IPv6 APT selects only the invocation-scoped IPv6 option and prohibits IPv4", async () => {
		const calls: string[] = [];
		const ipv6 = rankTransports([
			{
				candidate: { ifname: "eth0", kind: "ethernet", metered: false },
				family: 6,
				hosts: [{ host: "fixture", state: "clear", latencyMs: 1 }],
			},
		]);
		const controller = createUpdatePinController({
			readCapabilities: async () => capabilities,
			run: async (_bin, args) => {
				calls.push(args.join(" "));
				return args.join(" ") === "-6 route show default"
					? "default via fe80::1 dev eth0 proto ra metric 100\n"
					: "";
			},
		});
		await controller.sweep();
		await controller.run("apt", ipv6, async (_candidate, flags) => {
			expect(flags).toEqual(["-o", "Acquire::ForceIPv6=true"]);
			return "done";
		});
		expect(calls).toContain(
			"rule add priority 120 uidrange 42042-42042 prohibit",
		);
		expect(calls).toContain(
			`-6 rule add priority 120 uidrange 42042-42042 lookup ${UPDATE_TRANSPORT_TABLE_BASE}`,
		);
	});
});
