import { z } from "zod";
import type { run } from "../../helpers/run.ts";

const stateSchema = z.object({
	rules: z.array(z.string()),
	tables: z.array(z.string()),
});
export type RoutingState = z.infer<typeof stateSchema>;

// Linux deletes one matching rule per command, not all equal rules.
export async function routingFake(path: string) {
	const state: RoutingState = (await Bun.file(path).exists())
		? stateSchema.parse(JSON.parse(await Bun.file(path).text()))
		: { rules: [], tables: [] };
	const runner: typeof run = async (_bin, args) => {
		const family = args[0] === "-6" ? "6" : "4";
		const tokens = args.filter((arg) => arg !== "-6");
		const action = tokens.join(" ");
		const key = `${family}:${tokens.slice(2).join(" ")}`;
		if (action === "route show default")
			return "default dev eth0\ndefault dev wlan0";
		if (action === "rule show")
			return state.rules
				.filter((rule) => rule.startsWith(`${family}:`))
				.map((rule) => `120: from all ${rule.split("priority 120 ")[1]}`)
				.join("\n");
		if (tokens[0] === "rule" && tokens[1] === "add") state.rules.push(key);
		if (tokens[0] === "rule" && tokens[1] === "del") {
			const index = state.rules.indexOf(key);
			if (index < 0)
				throw Object.assign(new Error("rule absent"), {
					stderr: "RTNETLINK answers: No such file or directory\n",
				});
			state.rules.splice(index, 1);
		}
		if (tokens[0] === "route" && tokens[1] === "add") state.tables.push(key);
		if (tokens[0] === "route" && tokens[1] === "del") {
			const index = state.tables.indexOf(key);
			if (index < 0)
				throw Object.assign(new Error("route absent"), {
					stderr: "RTNETLINK answers: No such process\n",
				});
			state.tables.splice(index, 1);
		}
		if (tokens[0] === "route" && tokens[1] === "show" && tokens[2] === "table")
			return state.tables
				.filter(
					(row) =>
						row.startsWith(`${family}:`) && row.includes(`table ${tokens[3]}`),
				)
				.map((row) => row.slice(2))
				.join("\n");
		if (tokens[0] === "route" && tokens[1] === "flush")
			state.tables = state.tables.filter(
				(table) =>
					!table.startsWith(`${family}:`) ||
					!table.includes(`table ${tokens[3]}`),
			);
		await Bun.write(path, JSON.stringify(state));
		return "";
	};
	return { state, runner };
}
