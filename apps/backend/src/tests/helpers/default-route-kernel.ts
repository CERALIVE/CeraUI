import type { run } from "../../helpers/run.ts";
import { runTestCommand } from "./run-test-command.ts";

export const kernelRouteRunner: typeof run = async (bin, args) => {
	const result = await runTestCommand([bin, ...args]);
	if (result.code !== 0)
		throw new Error(`${bin} ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
};

export async function waitForKernelLinkdown(
	readRoutes: () => Promise<string>,
): Promise<string> {
	const deadline = performance.now() + 2_000;
	let routes = await readRoutes();
	while (!/proto 242.*linkdown/.test(routes)) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) break;
		await Bun.sleep(Math.min(50, remaining));
		routes = await readRoutes();
	}
	return routes;
}

export async function setupKernelRoutes(): Promise<void> {
	await kernelRouteRunner("ip", ["link", "set", "lo", "up"]);
	await kernelRouteRunner("ip", ["link", "add", "routea", "type", "dummy"]);
	await kernelRouteRunner("ip", [
		"link",
		"add",
		"routeb",
		"type",
		"veth",
		"peer",
		"name",
		"peerb",
	]);
	for (const name of ["routea", "routeb", "peerb"])
		await kernelRouteRunner("ip", ["link", "set", name, "up"]);
	await kernelRouteRunner("ip", [
		"addr",
		"add",
		"192.0.2.2/24",
		"dev",
		"routea",
	]);
	await kernelRouteRunner("ip", [
		"addr",
		"add",
		"198.51.100.2/24",
		"dev",
		"routeb",
	]);
	for (const name of ["routea", "routeb"])
		await kernelRouteRunner("ip", [
			"-6",
			"addr",
			"add",
			"fe80::10/64",
			"dev",
			name,
			"nodad",
		]);
}
