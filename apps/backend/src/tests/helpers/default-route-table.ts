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
			if (args.includes("table")) throw new Error("no named table");
			return [...table].join("\n");
		}
		this.mutations.push(args);
		if (this.mutations.length === this.failMutation)
			throw new Error("injected mutation failure");
		const row = args.slice(start + 2).join(" ");
		switch (verb) {
			case "add":
				if (table.has(row)) throw new Error("route exists");
				table.add(row);
				break;
			case "del":
				if (!table.delete(row)) throw new Error("route absent");
				break;
			default:
				throw new Error(`unsupported fixture operation: ${verb}`);
		}
		return "";
	};

	rows(family: 4 | 6 = 4): string[] {
		return [...(this.routes.get(family) ?? [])].sort();
	}
}
