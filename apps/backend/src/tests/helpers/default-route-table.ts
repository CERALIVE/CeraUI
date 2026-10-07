import type { run } from "../../helpers/run.ts";

/** Mutable kernel-table fake: exact argv replay, no module or command mocks. */
export class DefaultRouteTable {
	readonly routes = new Map<4 | 6, Set<string>>();
	readonly mutations: string[][] = [];
	failMutation = 0;

	constructor(v4: readonly string[], v6: readonly string[] = []) {
		this.routes.set(4, new Set(v4));
		this.routes.set(6, new Set(v6));
	}

	readonly runner: typeof run = async (_bin, args) => {
		const family = args.includes("-6") ? 6 : 4;
		const table = this.routes.get(family);
		if (!table) throw new Error("missing fixture family");
		const start = args.indexOf("route");
		const verb = args[start + 1];
		if (verb === "show") {
			if (args.includes("table") && !args.includes("main"))
				throw new Error("no named table");
			return [...table].join("\n");
		}
		if (verb === "get") {
			return this.orderedRows(family)[0] ?? "";
		}
		this.mutations.push(args);
		if (this.mutations.length === this.failMutation)
			throw new Error("injected mutation failure");
		const row = args.slice(start + 2).join(" ");
		if (/\b(linkdown|dead)\b/.test(row))
			throw new Error("display flag is garbage");
		switch (verb) {
			case "prepend": {
				if (table.has(row)) throw new Error("route exists");
				const previous = [...table];
				table.clear();
				table.add(row);
				for (const existing of previous) table.add(existing);
				break;
			}
			case "add":
			case "append":
				if (table.has(row)) throw new Error("route exists");
				table.add(row);
				break;
			case "del":
				{
					const identity = (value: string) =>
						["via", "dev", "src", "proto", "metric", "realm"]
							.map(
								(key) =>
									new RegExp(`\\b${key} (\\S+)`).exec(value)?.[1] ??
									(key === "metric" || key === "realm" ? "0" : ""),
							)
							.join("|") + String(value.split(" ").includes("onlink"));
					const existing = [...table].find(
						(value) => identity(value) === identity(row),
					);
					if (existing === undefined) throw new Error("route absent");
					table.delete(existing);
				}
				break;
			default:
				throw new Error(`unsupported fixture operation: ${verb}`);
		}
		return "";
	};

	rows(family: 4 | 6 = 4): string[] {
		return [...(this.routes.get(family) ?? [])].sort();
	}

	orderedRows(family: 4 | 6 = 4): string[] {
		const metric = (row: string) =>
			Number(/\bmetric (\d+)/.exec(row)?.[1] ?? (family === 6 ? 1024 : 0));
		return [...(this.routes.get(family) ?? [])].sort(
			(a, b) => metric(a) - metric(b),
		);
	}
}
