/// <reference lib="es2022" />
import { expect } from "bun:test";
import type { run } from "../../helpers/run.ts";
import { setDefaultRoute } from "../../modules/network/default-route.ts";
import { GatewayRoutePreference } from "../../modules/network/gateway-route-lifecycle.ts";
import { kernelRouteRunner as runner } from "./default-route-kernel.ts";

const ip = (command: string) => runner("ip", command.split(" "));
const defaults = (family: 4 | 6) =>
	ip(`${family === 6 ? "-6 " : ""}-N route show default`);

export const cleanupKernelScenarios: Readonly<
	Record<string, () => Promise<void>>
> = {
	...Object.fromEntries(
		["failback", "startup", "shutdown"].map((action) => [
			`IPv6 ${action} after carrier loss`,
			async () => {
				// Given: the owned IPv6 route keeps its address but loses carrier.
				await ip(
					"-6 route add default via fe80::1 dev routea proto 9 metric 37",
				);
				await ip(
					"-6 route add default via fe80::2 dev routeb proto 9 metric 83",
				);
				const controller = new GatewayRoutePreference(runner);
				await controller.start();
				await controller.apply("routeb", 6);
				await ip("link set peerb down");
				expect(await defaults(6)).toMatch(/proto 242.*linkdown/);
				const foreign = (await defaults(6))
					.split("\n")
					.filter((row) => !row.includes("proto 242"))
					.join("\n");
				// When: a product lifecycle boundary sweeps the carrier-lost preference.
				switch (action) {
					case "failback":
						await controller.apply("routea", 6);
						break;
					case "startup":
						await new GatewayRoutePreference(runner).start();
						break;
					case "shutdown":
						await controller.stop();
						break;
					default:
						throw new Error("fixture action missing");
				}
				// Then: neither foreign default nor order is changed.
				expect(await defaults(6)).toBe(foreign);
			},
		]),
	),
	"RT3-M2 real release attempts both families and aggregates deletion errors":
		async () => {
			// Given: protocol-pair crash residue shares its endpoint with a foreign route.
			await ip("route add default dev routea proto 16 metric 7");
			await ip("route prepend default dev routea proto 242 metric 7");
			await ip("route prepend default dev routea proto 243 metric 7");
			await ip(
				"-6 route add default via fe80::1 dev routea proto 242 metric 7",
			);
			const calls: string[][] = [];
			const refused: typeof run = async (bin, args, opts) => {
				if (args.includes("del")) {
					calls.push(args);
					if (!args.includes("-6"))
						throw new Error("injected IPv4 delete refusal");
				}
				return runner(bin, args, opts);
			};
			// When: both IPv4 deletes fail while the real IPv6 delete can run.
			const error: unknown = await setDefaultRoute(undefined, {
				runner: refused,
			}).catch((error: unknown) => error);
			// Then: every selector was attempted, both causes survive, and retry removes residue.
			if (!(error instanceof Error) || !(error.cause instanceof AggregateError))
				throw new Error("aggregate missing");
			expect(error.cause.errors).toHaveLength(2);
			expect(calls).toHaveLength(3);
			expect(await defaults(6)).toBe("");
			await setDefaultRoute(undefined, { runner });
			expect(await defaults(4)).toMatch(/^default dev routea proto 16/);
		},
	"RT3-S2/S3 legacy attributes are exact cleanup selectors, not generations":
		async () => {
			// Given: a host may preserve old realm attributes, although the target drops them.
			await ip("route add default dev routea proto 16 metric 7");
			await ip(
				"route prepend default dev routea proto 242 metric 7 realms 5/1",
			);
			await ip(
				"route prepend default dev routea proto 243 metric 7 realm 65535",
			);
			const commands: string[][] = [];
			const traced: typeof run = (bin, args, opts) => {
				if (args.includes("del")) commands.push(args);
				return runner(bin, args, opts);
			};
			const observed = await defaults(4);
			// When: product release handles precisely what the kernel actually dumps.
			await setDefaultRoute(undefined, { runner: traced });
			// Then: target erasure needs no attribute; preserved legacy attributes stay in selectors.
			if (observed.includes("realms 5/1"))
				expect(commands.some((args) => args.includes("5/1"))).toBe(true);
			if (observed.includes("realm 65535"))
				expect(commands.some((args) => args.includes("65535"))).toBe(true);
			expect(await defaults(4)).toMatch(/^default dev routea proto 16/);
		},
};
