import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { run, runWithStdin } from "../helpers/run.ts";
import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
import {
	type PreparedSteeringState,
	UplinkSteeringApplier,
} from "../modules/network/uplink-steering/applier.ts";
import type { SteeringAvailability } from "../modules/network/uplink-steering/contracts.ts";
import { UplinkSteeringCoordinator } from "../modules/network/uplink-steering/coordinator.ts";
import {
	discoverOwnedUplinkRoutes,
	ensureUplinkRoute,
	planUplinkRoute,
	removeUplinkRoute,
	rollbackUplinkRoute,
} from "../modules/network/uplink-steering/route-manager.ts";
import {
	buildShareRuleset,
	markForSlot,
	stableUplinkMark,
} from "../modules/network/uplink-steering/ruleset.ts";
import {
	readDesiredSteeringState,
	type SteeringStateBuilderDeps,
} from "../modules/network/uplink-steering/state-builder.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

interface Device {
	readonly identity: string;
	readonly ifname: string;
	readonly slot?: number;
}
interface Step {
	readonly devices: readonly Device[];
	readonly restart?: boolean;
	readonly interrupted?: "join" | "leave";
}
const earlier = { identity: "constructed-twin-322", ifname: "wwan0" };
const later = { identity: "constructed-twin-386", ifname: "wwan1" };
const third = { identity: "constructed-third", ifname: "wwan2", slot: 0x6718 };
const control = { identity: "constructed-control", ifname: "wwan0" };
const scenarios: readonly {
	readonly name: string;
	readonly duplicate: boolean;
	readonly steps: readonly Step[];
}[] = [
	{
		name: "duplicate-address join and repeated mid-sequence restarts",
		duplicate: true,
		steps: [
			{ devices: [later] },
			{ devices: [earlier, later] },
			{ devices: [earlier, later], restart: true },
			{ devices: [later] },
			{ devices: [later], restart: true },
			{ devices: [later, earlier] },
			{ devices: [later, earlier], restart: true },
		],
	},
	{
		name: "duplicate-address surviving prober restart",
		duplicate: true,
		steps: [
			{ devices: [earlier, later] },
			{ devices: [later] },
			{ devices: [later], restart: true },
		],
	},
	{
		name: "three-way collision restart between arrivals and departures",
		duplicate: true,
		steps: [
			{ devices: [later] },
			{ devices: [third, later] },
			{ devices: [third, later], restart: true },
			{ devices: [earlier, third, later] },
			{ devices: [earlier, third, later], restart: true },
			{ devices: [third, later] },
			{ devices: [third, later], restart: true },
		],
	},
	{
		name: "unique-address collision join and leave restarts",
		duplicate: false,
		steps: [
			{ devices: [later] },
			{ devices: [earlier, later] },
			{ devices: [earlier, later], restart: true },
			{ devices: [later] },
			{ devices: [later], restart: true },
		],
	},
	{
		name: "restart reserves a disappeared owner until conntrack retirement",
		duplicate: true,
		steps: [
			{ devices: [later] },
			{ devices: [earlier], restart: true },
			{ devices: [earlier, third] },
			{ devices: [earlier, third], restart: true },
			{ devices: [earlier, third, later] },
			{ devices: [earlier, third, later], restart: true },
		],
	},
	{
		name: "restart after join provisioning before ruleset commit",
		duplicate: true,
		steps: [
			{ devices: [later] },
			{ devices: [earlier, later], restart: true, interrupted: "join" },
		],
	},
	{
		name: "restart after leave retirement before final ruleset commit",
		duplicate: true,
		steps: [
			{ devices: [earlier, later] },
			{ devices: [later], restart: true, interrupted: "leave" },
		],
	},
	{
		name: "non-colliding duplicate-address restart control",
		duplicate: true,
		steps: [
			{ devices: [later] },
			{ devices: [control, later] },
			{ devices: [control, later], restart: true },
		],
	},
	{
		name: "cold collision start without any kernel history",
		duplicate: true,
		steps: [{ devices: [later, earlier] }],
	},
];
const child = process.env.CERALIVE_STEERING_RESTART_KERNEL_CHILD === "1";
const probe = child
	? undefined
	: await runTestCommand(["unshare", "-Urn", "true"]);
const unavailable = probe !== undefined && probe.code !== 0;

function netif(ip: string): NetworkInterface {
	return {
		ip,
		netmask: "255.255.255.0",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
	};
}

for (const scenario of scenarios) {
	(unavailable ? test.skip : test)(
		`${scenario.name}${unavailable ? ` (SKIP: ${probe?.stderr.trim()})` : ""}`,
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
						scenario.name,
						"--timeout",
						"30000",
					],
					{ env: { CERALIVE_STEERING_RESTART_KERNEL_CHILD: "1" } },
				);
				console.log(result.stdout + result.stderr);
				expect(result.code, result.stdout + result.stderr).toBe(0);
				return;
			}
			const installed = new Set<string>();
			let devices: readonly Device[] = [];
			const statuses: SteeringAvailability[] = [];
			const flushed: number[] = [];
			const frames: unknown[] = [];
			await run("ip", ["link", "add", "eth9", "type", "dummy"]);
			await run("ip", ["address", "add", "10.43.0.1/24", "dev", "eth9"]);
			const routeDeps = { run };
			const deps: SteeringStateBuilderDeps = {
				netifReady: () => true,
				zonesReady: () => true,
				identityCovered: () => true,
				identityDeadlineExpired: () => false,
				interfaces: () => ({
					eth9: netif("10.43.0.1"),
					...Object.fromEntries(
						devices.map((device) => [
							device.ifname,
							netif(
								`100.64.${scenario.duplicate ? 1 : Number(device.ifname.slice(4))}.2`,
							),
						]),
					),
				}),
				health: () => [],
				wifiIdentity: () => undefined,
				physicalIdentity: (ifname) =>
					devices.find((device) => device.ifname === ifname)?.identity ?? "",
				markForIdentity: (identity) => {
					const device = devices.find((entry) => entry.identity === identity);
					return device?.slot === undefined
						? stableUplinkMark(identity)
						: markForSlot(device.slot);
				},
				isBondCandidate: () => false,
				isClientZone: (ifname) => ifname === "eth9",
				planRoute: (candidate) => planUplinkRoute(candidate, routeDeps),
				discoverRoutes: () => discoverOwnedUplinkRoutes(routeDeps),
			};
			function controller() {
				const applier = new UplinkSteeringApplier({
					discoverRoutes: () => discoverOwnedUplinkRoutes(routeDeps),
					ensureRoute: (route) => ensureUplinkRoute(route, routeDeps),
					rollbackRoute: (receipt) => rollbackUplinkRoute(receipt, routeDeps),
					removeRoute: (route) => removeUplinkRoute(route, routeDeps),
					applyRuleset: async (text) => {
						await runWithStdin("nft", ["-f", "-"], text);
					},
					deactivateSharing: async () => {
						await run("nft", ["delete", "table", "inet", "ceralive_share"]);
					},
					flushConntrack: async (mark) => {
						flushed.push(mark);
					},
					setIpForwarding: async () => {},
					publishFlowsReset: () => {},
				});
				return new UplinkSteeringCoordinator({
					readDesiredState: (context) =>
						readDesiredSteeringState(deps, context),
					apply: (previous, next) => applier.apply(previous, next),
					publishAvailability: (status) => statuses.push(status),
					waitBeforeRetry: async () => {},
				});
			}
			let coordinator = controller();
			let previous: PreparedSteeringState | undefined;
			try {
				for (const step of scenario.steps) {
					for (const device of step.devices) {
						if (installed.has(device.ifname)) continue;
						const index = Number(device.ifname.slice(4));
						const subnet = scenario.duplicate ? 1 : index;
						await run("ip", ["link", "add", device.ifname, "type", "dummy"]);
						await run("ip", ["link", "set", device.ifname, "up"]);
						await run("ip", [
							"address",
							"add",
							`100.64.${subnet}.2/24`,
							"dev",
							device.ifname,
						]);
						await run("ip", [
							"route",
							"add",
							"default",
							"via",
							`100.64.${subnet}.1`,
							"dev",
							device.ifname,
							"metric",
							String(50 + index * 50),
						]);
						installed.add(device.ifname);
					}
					devices = step.devices;
					const retiredAt = flushed.length;
					if (step.interrupted === "join") {
						const provisional = await readDesiredSteeringState(deps, {
							hasAppliedState: true,
							appliedUplinks: previous?.uplinks ?? [],
						});
						if ("pending" in provisional) throw new Error("join not ready");
						for (const route of provisional.routes) {
							if (
								previous?.routes.some((old) => old.identity === route.identity)
							)
								continue;
							await ensureUplinkRoute(route, routeDeps);
						}
					}
					if (step.interrupted === "leave") {
						if (previous === undefined) throw new Error("no state to retire");
						await runWithStdin(
							"nft",
							["-f", "-"],
							buildShareRuleset({
								clientZones: previous.clientZones,
								uplinks: previous.uplinks.map((uplink) =>
									devices.some((device) => device.identity === uplink.identity)
										? uplink
										: { ...uplink, selectable: false, weight: 0 },
								),
							}),
						);
						for (const route of previous.routes) {
							if (devices.some((device) => device.identity === route.identity))
								continue;
							flushed.push(route.mark);
							await removeUplinkRoute(route, routeDeps);
						}
					}
					if (step.restart) {
						coordinator.stop();
						coordinator = controller();
					}
					await coordinator.requestReconcile();
					expect(statuses.at(-1)).toEqual({ available: true });
					const applied = coordinator.appliedState();
					expect(applied?.uplinks).toHaveLength(devices.length);
					if (applied === undefined) throw new Error("no applied model");
					const paths: string[] = [];
					for (const uplink of applied.uplinks) {
						const lookup = await run("ip", [
							"route",
							"get",
							"203.0.113.1",
							"mark",
							`0x${uplink.mark.toString(16)}`,
						]);
						expect(lookup).toContain(`dev ${uplink.ifname} `);
						paths.push(lookup.trim());
					}
					for (const uplink of applied.uplinks) {
						const incumbent = previous?.uplinks.find(
							(entry) => entry.identity === uplink.identity,
						);
						if (incumbent) expect(uplink.mark).toBe(incumbent.mark);
					}
					const departed =
						previous?.uplinks.filter(
							(entry) =>
								!devices.some((device) => device.identity === entry.identity),
						) ?? [];
					expect(flushed.slice(retiredAt).sort()).toEqual(
						departed.map((entry) => entry.mark).sort(),
					);
					if (scenario.name.startsWith("cold collision")) {
						expect(applied.uplinks.map(({ mark }) => mark)).toEqual([
							0xca671800, 0xca671900,
						]);
					}
					frames.push({
						restart: !!step.restart,
						interrupted: step.interrupted,
						paths,
						retired: flushed.slice(retiredAt),
					});
					previous = applied;
				}
				console.log(JSON.stringify({ scenario: scenario.name, frames }));
			} finally {
				coordinator.stop();
			}
		},
		30_000,
	);
}
