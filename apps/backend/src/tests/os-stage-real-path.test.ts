import { expect, test } from "bun:test";
import {
	classifyPinnedTopology,
	probePinnedBundle,
	readPinnedTopology,
} from "../modules/system/update-orchestrator/os-stage-path.ts";
import type { RankedTransport } from "../modules/system/update-transport/core.ts";
import {
	runPinnedStep,
	sweepUpdateRules,
} from "../modules/system/update-transport/pin-rules.ts";
import { realDeviceSection } from "./helpers/real-device-fixture.ts";

const transport: RankedTransport = {
	candidate: { ifname: "eth0", kind: "ethernet", metered: false },
	family: 4,
	hosts: [{ host: "fixture", state: "clear", latencyMs: 1 }],
	healthy: true,
	reason: "clear",
	latencyMs: 1,
};
async function topology() {
	return {
		transport,
		links: await realDeviceSection("rock", "links"),
		addresses: await realDeviceSection("rock", "addresses"),
		routes: await realDeviceSection("rock", "routes"),
		carrier: await realDeviceSection("rock", "carrier"),
	};
}

test("parses real ip JSON and carrier with main-table route grammar", async () => {
	const input = await topology();
	const result = classifyPinnedTopology(input);
	expect(result).toEqual({ kind: "healthy" });
});

test("real empty private table is route loss, not a healthy installed pin", async () => {
	const input = await topology();
	const routes = await realDeviceSection("rock", "private-routes");
	const result = classifyPinnedTopology({ ...input, routes });
	expect(result).toEqual({ kind: "lost", reason: "private-route-lost" });
});

test("reads the product's exact ip argv through real captured replies", async () => {
	const input = await topology();
	const routes = await realDeviceSection("rock", "private-routes");
	const commands: string[][] = [];
	const result = await readPinnedTopology(transport, {
		read: async () => input.carrier,
		run: async (argv) => {
			commands.push(argv);
			return {
				exitCode: 0,
				stderr: "",
				stdout: argv.includes("link")
					? input.links
					: argv.includes("address")
						? input.addresses
						: routes,
			};
		},
	});
	expect(result).toEqual({ kind: "lost", reason: "private-route-lost" });
	expect(commands).toEqual([
		["ip", "-j", "link", "show"],
		["ip", "-j", "-4", "address", "show", "dev", "eth0"],
		["ip", "-j", "-4", "route", "show", "table", "100001"],
	]);
});

test("a real IPv6 address cannot be used as IPv4 path evidence", async () => {
	const input = await topology();
	const addresses = await realDeviceSection("rock", "addresses6");
	const result = classifyPinnedTopology({ ...input, addresses });
	expect(result).toEqual({ kind: "lost", reason: "family-address-lost" });
});

test("the real successful curl 404 remains unavailable rather than transport loss", async () => {
	const captured = await realDeviceSection("rock", "curl-head");
	const stdout = captured.split("\n")[0] ?? "";
	const result = await probePinnedBundle(
		"https://images.ceralive.tv/channels/stable/rock-5b-plus.json.sig",
		transport,
		async () => ({ exitCode: 0, stdout, stderr: "" }),
	);
	expect(result).toEqual({ kind: "unavailable" });
});

test("sweeps real default rules without deleting a foreign rule", async () => {
	const rules4 = await realDeviceSection("rock", "rules4");
	const rules6 = await realDeviceSection("rock", "rules6");
	const commands: string[][] = [];
	await sweepUpdateRules(async (_command, argv = []) => {
		commands.push([...argv]);
		return argv.includes("show") ? (argv.includes("-6") ? rules6 : rules4) : "";
	});
	expect(commands.filter((argv) => argv.includes("del"))).toEqual([]);
});

test("sweep refuses a foreign priority-120 row added to the real rules", async () => {
	const rules = `${await realDeviceSection("rock", "rules4")}120:\tfrom all lookup 42\n`;
	await expect(sweepUpdateRules(async () => rules)).rejects.toHaveProperty(
		"reason",
		"foreign-rule",
	);
});

test("pin route selection preserves the real default's device and source", async () => {
	const routes = await realDeviceSection("rock", "routes-default");
	const commands: string[][] = [];
	await runPinnedStep({
		job: "os",
		uid: 987,
		transport,
		step: async () => true,
		runner: async (_command, argv = []) => {
			commands.push([...argv]);
			return argv.includes("show") ? routes : "";
		},
	});
	expect(commands).toContainEqual([
		"route",
		"add",
		"default",
		"via",
		"198.51.100.1",
		"dev",
		"eth0",
		"proto",
		"dhcp",
		"src",
		"198.51.100.131",
		"table",
		"100001",
		"metric",
		"0",
	]);
});
