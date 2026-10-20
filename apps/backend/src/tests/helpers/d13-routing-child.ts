import { join } from "node:path";
import { z } from "zod";
import { aptRoutingFileStore } from "../../modules/system/apt-routing-journal.ts";
import { createAptRoutingOwnership } from "../../modules/system/apt-routing-ownership.ts";
import { routingFake } from "./d13-fix-routing-fake.ts";

const [dir, phase] = z
	.tuple([
		z.string().min(1),
		z.string().regex(/^(?:before|after)-[0-3]$|^step$/),
	])
	.parse(process.argv.slice(2));
const fake = await routingFake(join(dir, "kernel.json"));
const store = aptRoutingFileStore(join(dir, "journal.json"));
const hold = async () => {
	process.stdout.write("READY\n");
	await new Response(Bun.stdin.stream()).text();
};
let index = 0;
const lease = await createAptRoutingOwnership(store).acquire(
	async (bin, args) => {
		if (!args.includes("add")) return fake.runner(bin, args);
		if (phase === `before-${index}`) await hold();
		const result = await fake.runner(bin, args);
		if (phase === `after-${index}`) await hold();
		index++;
		return result;
	},
	42042,
);
for (const args of [
	[
		"route",
		"add",
		"unreachable",
		"default",
		"table",
		"100000",
		"metric",
		"4278198272",
	],
	["route", "add", "default", "dev", "eth0", "table", "100000", "metric", "0"],
	[
		"-6",
		"rule",
		"add",
		"priority",
		"120",
		"uidrange",
		"42042-42042",
		"prohibit",
	],
	[
		"rule",
		"add",
		"priority",
		"120",
		"uidrange",
		"42042-42042",
		"lookup",
		"100000",
	],
])
	await lease.runner("ip", args);
if (phase === "step") await hold();
throw new Error("crash fixture was not stopped at its boundary");
