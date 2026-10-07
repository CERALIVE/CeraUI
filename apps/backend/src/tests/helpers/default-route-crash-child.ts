import { setDefaultRoute } from "../../modules/network/default-route.ts";
import { kernelRouteRunner } from "./default-route-kernel.ts";

if (process.env.CERALIVE_ROUTE_CRASH_CHILD !== "1" || process.getuid?.() !== 0)
	throw new Error("isolated child required");
const stopAfter = Number(process.env.CERALIVE_ROUTE_CRASH_AFTER ?? "1");
let mutations = 0;
await setDefaultRoute(process.env.CERALIVE_ROUTE_CRASH_TARGET ?? "routeb", {
	family: process.env.CERALIVE_ROUTE_CRASH_FAMILY === "6" ? 6 : 4,
	runner: async (bin, args, opts) => {
		const result = await kernelRouteRunner(bin, args, opts);
		if (
			["prepend", "add", "del"].includes(args[args.indexOf("route") + 1] ?? "")
		) {
			mutations++;
			if (mutations === stopAfter) {
				await new Promise<void>((resolve, reject) => {
					process.stdout.write(`KILL AFTER ${args.join(" ")}\n`, (error) => {
						if (error) reject(error);
						else resolve();
					});
				});
				process.kill(process.pid, "SIGKILL");
				await new Promise<never>(() => undefined);
			}
		}
		return result;
	},
});
