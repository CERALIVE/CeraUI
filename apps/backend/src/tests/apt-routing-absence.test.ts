import { expect, test } from "bun:test";
import type { run } from "../helpers/run.ts";
import type { AptRoutingEntry } from "../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../modules/system/apt-routing-ownership.ts";
import captured from "./fixtures/iproute2-7.2-absent.json";

const accepted = [
	"No such file or directory",
	"No such process",
	"FIB table does not exist",
	"RTNETLINK answers: No such file or directory\n",
	"RTNETLINK answers: No such process\n",
	"RTNETLINK answers: FIB table does not exist\n",
	captured.delete,
	"Error: ipv4: FIB table does not exist.\n",
	"Error: ipv6: FIB table does not exist.\n",
	captured.ipv4,
	captured.ipv6,
] as const;
const unknown = [
	"",
	"Dump terminated\n",
	"Error: Operation not permitted\n",
	"Error: ipv4: FIB table does not exist.\nPermission denied\n",
	"Error: ipv6: FIB table does not exist.\nDump terminated\nError: interrupted\n",
	"untrusted prefix FIB table does not exist",
	"FIB table does not exist unexpectedly",
	"Error: ipv5: FIB table does not exist.\nDump terminated\n",
	"RTNETLINK answers: File exists\n",
	"No such process\nDump terminated\n",
	captured.device,
] as const;

test.each([...accepted])(
	"admits empty tables for the complete known reply %#",
	async (stderr) => {
		// Given an empty journal and the same complete kernel reply from both families.
		const families: string[] = [];
		const owner = createAptRoutingOwnership({
			read: async () => [],
			save: () => {},
		});
		const runner: typeof run = async (_bin, args) => {
			if (args.includes("route")) {
				families.push(args[0] === "-6" ? "6" : "4");
				throw Object.assign(new Error("kernel reply"), { stderr });
			}
			return "";
		};
		// When the real admission probes both reserved tables.
		const lease = await owner.acquire(runner, 42042);
		lease.release();
		// Then both absent tables were accepted as empty.
		expect(families).toEqual(["4", "6"]);
	},
);

test.each([
	[captured.device, true],
	[captured.device.trim(), true],
	[` \t${captured.device}\n`, true],
	['Cannot find device "eth1"', false],
	['Cannot find device "eth0"\nPermission denied', false],
	['prefix Cannot find device "eth0"', false],
	['Cannot find device "eth0" suffix', false],
	["Cannot find device 'eth0'", false],
	["Cannot find device eth0", false],
])(
	"reconciles only the route's own complete device reply %#",
	async (stderr, retires) => {
		// Given exact default-route intents in both families and a complete/near-miss reply.
		for (const family of [4, 6] as const) {
			let entries: readonly AptRoutingEntry[] = [
				{
					family,
					args: [
						"route",
						"add",
						"default",
						"dev",
						"eth0",
						"table",
						"100000",
						"metric",
						"0",
					],
				},
			];
			const owner = createAptRoutingOwnership({
				read: async () => entries,
				save: (next) => {
					entries = next;
				},
			});
			const runner: typeof run = async (_bin, args) => {
				if (args.includes("del"))
					throw Object.assign(new Error("kernel reply"), { stderr });
				return "";
			};
			// When restart reconciliation deletes the journaled route.
			await expect(owner.acquire(runner, 42042)).rejects.toHaveProperty(
				"reason",
				retires ? "cleanup-pending" : "journal-unavailable",
			);
			// Then only proven absence retires ownership; unknown replies keep the fence.
			expect(entries).toHaveLength(retires ? 0 : 1);
			if (retires) (await owner.acquire(runner, 42042)).release();
		}
	},
);

test.each(["rule", "device-free route"])(
	"refuses missing-device reply for %s intent",
	async (kind) => {
		// Given an intent without route-device authority (even if a rule has dev tokens).
		let entries: readonly AptRoutingEntry[] = [
			{
				family: 4,
				args:
					kind === "rule"
						? ["rule", "add", "dev", "eth0"]
						: [
								"route",
								"add",
								"unreachable",
								"default",
								"table",
								"100000",
								"metric",
								"4278198272",
							],
			},
		];
		const owner = createAptRoutingOwnership({
			read: async () => entries,
			save: (next) => {
				entries = next;
			},
		});
		const runner: typeof run = async () => {
			throw Object.assign(new Error("kernel reply"), {
				stderr: captured.device,
			});
		};
		// When a missing-device error is returned for that unrelated intent.
		await expect(owner.acquire(runner, 42042)).rejects.toHaveProperty(
			"reason",
			"journal-unavailable",
		);
		// Then no ownership is silently retired.
		expect(entries).toHaveLength(1);
	},
);

test.each([...accepted])(
	"retires already-absent exact intents for the complete known reply %#",
	async (stderr) => {
		// Given reboot-surviving route intents for both families.
		let entries: readonly AptRoutingEntry[] = [4, 6].map((family) => ({
			family: family === 4 ? 4 : 6,
			args: [
				"route",
				"add",
				"unreachable",
				"default",
				"table",
				"100000",
				"metric",
				"4278198272",
			],
		}));
		const owner = createAptRoutingOwnership({
			read: async () => entries,
			save: (next) => {
				entries = next;
			},
		});
		const runner: typeof run = async (_bin, args) => {
			if (args.includes("del"))
				throw Object.assign(new Error("kernel reply"), { stderr });
			return "";
		};
		// When recovery observes that each exact intent is already absent.
		await expect(owner.acquire(runner, 42042)).rejects.toHaveProperty(
			"reason",
			"cleanup-pending",
		);
		// Then retirement is durable and only the next admission may run.
		expect(entries).toEqual([]);
		(await owner.acquire(runner, 42042)).release();
	},
);

test.each([...unknown])(
	"refuses unknown or partial observations without retiring ownership %#",
	async (stderr) => {
		// Given an unrecognised answer, including extra lines after a known first line.
		for (const family of [4, 6] as const) {
			let entries: readonly AptRoutingEntry[] = [];
			const store = {
				read: async () => entries,
				save: (next: readonly AptRoutingEntry[]) => {
					entries = next;
				},
			};
			const runner: typeof run = async (_bin, args) => {
				if (args.includes("route") && (args[0] === "-6" ? 6 : 4) === family)
					throw Object.assign(new Error("kernel reply"), { stderr });
				return "";
			};
			// When admission and restart reconciliation encounter that answer.
			await expect(
				createAptRoutingOwnership(store).acquire(runner, 42042),
			).rejects.toHaveProperty("reason", "journal-unavailable");
			entries = [
				{
					family,
					args: [
						"route",
						"add",
						"unreachable",
						"default",
						"table",
						"100000",
						"metric",
						"4278198272",
					],
				},
			];
			await expect(
				createAptRoutingOwnership(store).acquire(runner, 42042),
			).rejects.toHaveProperty("reason", "journal-unavailable");
			// Then the exact intent stays fenced rather than being declared absent.
			expect(entries).toHaveLength(1);
		}
	},
);
