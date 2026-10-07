import { expect } from "bun:test";
import { fileURLToPath } from "node:url";
import type { run } from "../../helpers/run.ts";
import { setDefaultRoute } from "../../modules/network/default-route.ts";
import { GatewayRoutePreference } from "../../modules/network/gateway-route-lifecycle.ts";
import { kernelRouteRunner as runner } from "./default-route-kernel.ts";
import { runTestCommand } from "./run-test-command.ts";

const ip = (command: string) => runner("ip", command.split(" "));
const dump = () => ip("-4 route show table all");
const fib = (family: 4 | 6) =>
	ip(
		`${family === 6 ? "-6 " : ""}-N route get ${family === 6 ? "2001:db8::1" : "8.8.8.8"} fibmatch`,
	);

export const oracle4KernelScenarios: Readonly<
	Record<string, () => Promise<void>>
> = {
	...Object.fromEntries(
		([4, 6] as const).flatMap((family) =>
			["hl1", "wlan0"].map((second) => [
				`RT3-M1 IPv${family} switches ${second} versus modem`,
				async () => {
					// Given: the Rock metric shape, with two non-natural uplinks.
					const names = ["eth0", second, "modem0"];
					for (const [index, name] of names.entries()) {
						await ip(`link add ${name} type dummy`);
						await ip(`link set ${name} up`);
						await ip(`addr add 198.18.${index}.2/24 dev ${name}`);
						await ip(`-6 addr add fe80::10/64 dev ${name} nodad`);
						await ip(
							`${family === 6 ? "-6 " : ""}route add default via ${family === 6 ? `fe80::${index + 1}` : `198.18.${index}.1`} dev ${name} proto 16 metric ${[50, 702, 703][index]}`,
						);
					}
					const before = await ip(
						`${family === 6 ? "-6 " : ""}-N route show default`,
					);
					const controller = new GatewayRoutePreference(runner);
					await controller.start();
					// When: each non-natural uplink wins in turn, then wins back.
					for (const target of [second, "modem0", second]) {
						await controller.apply(target, family);
						expect(await fib(family)).toContain(`dev ${target} proto 24`);
					}
					await controller.stop();
					// Then: all original defaults and their order survive.
					expect(
						await ip(`${family === 6 ? "-6 " : ""}-N route show default`),
					).toBe(before);
				},
			]),
		),
	),
	"RT3-M3 metric floor ignores dropped realms": async () => {
		// Given: emulate the shipped kernel's unconditional erasure of RTA_FLOW.
		await ip("route add default via 192.0.2.1 dev routea proto 16");
		await ip(
			"route add default via 198.51.100.1 dev routeb proto 16 metric 83",
		);
		const before = await dump();
		const boardRunner: typeof run = (bin, args, opts) => {
			const index = args.findIndex(
				(arg) => arg === "realm" || arg === "realms",
			);
			return runner(
				bin,
				index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)],
				opts,
			);
		};
		// When: a floor election is acquired and reconciled unchanged 100 times.
		let mutations = 0;
		const counted: typeof run = (bin, args, opts) => {
			if (
				["prepend", "add", "del"].includes(
					args[args.indexOf("route") + 1] ?? "",
				)
			)
				mutations++;
			return boardRunner(bin, args, opts);
		};
		for (let i = 0; i < 100; i++)
			await setDefaultRoute("routeb", { runner: counted });
		// Then: only the first acquisition writes, and the real FIB chooses routeb.
		expect(mutations).toBe(1);
		expect(await fib(4)).toContain("dev routeb proto 242");
		await setDefaultRoute(undefined, { runner: counted });
		expect(await dump()).toBe(before);
	},
	...Object.fromEntries(
		([4, 6] as const).flatMap((family) =>
			[1, 2].map((after) => [
				`RT3-M2 IPv${family} SIGKILL command ${after} converges`,
				async () => {
					// Given: an active preference, with DHCP renewal at the IPv4 floor.
					const flag = family === 6 ? "-6 " : "";
					await ip(
						`${flag}route add default via ${family === 6 ? "fe80::1" : "192.0.2.1"} dev routea proto 16 metric ${family === 6 ? 37 : 0}`,
					);
					await ip(
						`${flag}route add default via ${family === 6 ? "fe80::2" : "198.51.100.1"} dev routeb proto 16 metric 83`,
					);
					const before = await ip(`${flag}-N route show default`);
					await setDefaultRoute("routeb", { runner, family });
					if (family === 4) {
						await ip(
							"route del default via 192.0.2.1 dev routea proto 16 metric 0",
						);
						await ip(
							"route prepend default via 192.0.2.1 dev routea proto 16 metric 0",
						);
					} else {
						await ip("link add routec type dummy");
						await ip("link set routec up");
						await ip("-6 addr add fe80::10/64 dev routec nodad");
						await ip(
							"-6 route add default via fe80::3 dev routec proto 16 metric 100",
						);
					}
					// When: a real product child dies between successful mutation commands.
					const killed = await runTestCommand(
						[
							process.execPath,
							fileURLToPath(
								new URL("./default-route-crash-child.ts", import.meta.url),
							),
						],
						{
							env: {
								CERALIVE_ROUTE_CRASH_CHILD: "1",
								CERALIVE_ROUTE_CRASH_AFTER: String(after),
								CERALIVE_ROUTE_CRASH_FAMILY: String(family),
								CERALIVE_ROUTE_CRASH_TARGET: family === 4 ? "routeb" : "routec",
							},
						},
					);
					expect(killed.code).not.toBe(0);
					expect(killed.stdout).toContain("KILL AFTER");
					// Then: every lifecycle boundary converges without a refusal.
					const controller = new GatewayRoutePreference(runner);
					await controller.start();
					await controller.apply("routeb", family);
					expect(await fib(family)).toContain("dev routeb proto 24");
					await controller.apply(undefined);
					await controller.stop();
					if (family === 6)
						await ip(
							"-6 route del default via fe80::3 dev routec proto 16 metric 100",
						);
					expect(await ip(`${flag}-N route show default`)).toBe(before);
				},
			]),
		),
	),
	"RT3-S3 protocols and legacy realms select one row": async () => {
		// Given: identical endpoints differ only by ownership/generation.
		await ip("route add default dev routea proto 16 metric 7");
		await ip("route prepend default dev routea proto 242 metric 7");
		await ip("route prepend default dev routea proto 243 metric 7");
		const before = await ip("-N route show default");
		// When: protocol-qualified deletion selects exactly one generation.
		await ip("route del default dev routea proto 243 metric 7");
		// Then: neither the foreign nor other generation was matched.
		expect(await ip("-N route show default")).toBe(
			before
				.split("\n")
				.filter((row) => !row.includes("proto 243"))
				.join("\n"),
		);
		await setDefaultRoute(undefined, { runner });
		expect(await ip("-N route show default")).toMatch(
			/^default dev routea proto 16/,
		);
	},
};
