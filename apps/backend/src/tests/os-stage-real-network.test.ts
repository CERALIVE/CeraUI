import { expect, test } from "bun:test";
import {
	classifyPinnedTopology,
	readPinnedTopology,
} from "../modules/system/update-orchestrator/os-stage-path.ts";
import type { RankedTransport } from "../modules/system/update-transport/core.ts";
import {
	selectUpdateTransport,
	type UpdateTransportDeps,
} from "../modules/system/update-transport/executor.ts";
import { sweepUpdateRules } from "../modules/system/update-transport/pin-rules.ts";
import {
	realDeviceReply,
	realDeviceSection,
} from "./helpers/real-device-fixture.ts";

const transport: RankedTransport = {
	candidate: { ifname: "eth0", kind: "ethernet", metered: false },
	family: 4,
	hosts: [],
	healthy: true,
	reason: "clear",
	latencyMs: 0,
};

test.each([
	[100000, 4, "unknown"],
	[100000, 6, "unknown"],
	[100001, 4, "lost"],
	[100001, 6, "unknown"],
] as const)(
	"keeps table %s family %s exit status when reading real route output",
	async (table, family, kind) => {
		const links = await realDeviceReply("rock-readonly", "b2-links");
		const addresses = await realDeviceReply("rock-readonly", "b2-addresses");
		const routes = await realDeviceReply(
			"rock-readonly",
			`routes-${table}-${family}`,
		);
		const result = await readPinnedTopology(
			{ ...transport, family },
			{
				read: async () => realDeviceSection("rock-readonly", "b2-carrier"),
				run: async (argv) =>
					argv.includes("link")
						? links
						: argv.includes("address")
							? addresses
							: routes,
			},
		);
		expect(result).toEqual(
			kind === "lost" ? { kind, reason: "private-route-lost" } : { kind },
		);
	},
);

test.each([4, 6] as const)(
	"parses real mixed-family addresses before family %s route-loss classification",
	async (family) => {
		const result = classifyPinnedTopology({
			transport: { ...transport, family },
			links: await realDeviceSection("rock-readonly", "b2-links"),
			addresses: await realDeviceSection("rock-readonly", "b2-addresses"),
			routes: await realDeviceSection(
				"rock-readonly",
				`routes-100001-${family}`,
			),
			carrier: await realDeviceSection("rock-readonly", "b2-carrier"),
		});
		expect(result).toEqual({ kind: "lost", reason: "private-route-lost" });
	},
);

test("sweeps real IPv4 and IPv6 rules without mutating default or foreign rows", async () => {
	const mutableCommands: string[][] = [];
	await sweepUpdateRules(async (_command, argv = []) => {
		mutableCommands.push([...argv]);
		return realDeviceSection(
			"rock-readonly",
			argv.includes("-6") ? "b2-rules6" : "b2-rules4",
		);
	});
	expect(mutableCommands.filter((argv) => argv.includes("del"))).toEqual([]);
});

async function selection(profile: "os" | "apt") {
	const commands: string[][] = [];
	const deps: UpdateTransportDeps = {
		listIfnames: () => ["eth0"],
		mmIfnames: () => [],
		routerIfnames: () => [],
		dongleIfnames: () => [],
		credentials: async () => undefined,
		readSources: async () =>
			"Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n",
		run: async (argv) => {
			commands.push(argv);
			if (argv[0] === "nmcli") return realDeviceReply("rock-nmcli", "b2-nmcli");
			const host = argv.at(-1) ?? "";
			if (
				argv[0] === "resolvectl" &&
				["images.ceralive.tv", "apt.ceralive.tv"].includes(host)
			)
				return realDeviceReply(
					"rock-readonly",
					`dns-${host}-${argv.includes("-6") ? 6 : 4}`,
				);
			if (
				argv[0] === "curl" &&
				argv.includes("-4") &&
				host === "http://images.ceralive.tv/generate_204"
			)
				return realDeviceReply("rock-readonly", "curl-http");
			if (
				argv[0] === "curl" &&
				argv.includes("-4") &&
				host ===
					"https://images.ceralive.tv/channels/stable/rock-5b-plus.json.sig"
			)
				return realDeviceReply("rock-readonly", "curl-head");
			// Uncaptured transfers fail in the harness; they are not board evidence.
			return { exitCode: 7, stdout: "", stderr: "uncaptured transfer" };
		},
	};
	return {
		result: await selectUpdateTransport(
			{ profile, board: "rock-5b-plus", channel: "stable" },
			deps,
		),
		commands,
	};
}

test.each([
	["os", 4, "images.ceralive.tv:80:198.51.100.10"],
	["os", 6, "images.ceralive.tv:80:[2001:db8::12]"],
	["apt", 4, "apt.ceralive.tv:80:198.51.100.11"],
	["apt", 6, "apt.ceralive.tv:80:[2001:db8::12]"],
] as const)(
	"uses real %s family %s resolvectl framing in production resolve argv",
	async (profile, family, resolved) => {
		const { commands } = await selection(profile);
		expect(
			commands.some(
				(argv) =>
					argv[0] === "curl" &&
					argv.includes(`-${family}`) &&
					argv.includes(resolved),
			),
		).toBe(true);
	},
);

test("ranks real empty-body 204 plus verified-TLS 404 as a usable IPv4 OS path", async () => {
	const { result } = await selection("os");
	expect(result.ranked[0]?.hosts).toEqual([
		{ host: "images.ceralive.tv", state: "clear", latencyMs: 434 },
	]);
});
