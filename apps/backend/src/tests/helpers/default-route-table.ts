import type { run } from "../../helpers/run.ts";

export class KernelRouteCommandError extends Error {
	readonly exitCode = 2;
	constructor(
		readonly errno: "EEXIST" | "ESRCH",
		detail: string,
	) {
		super(
			`${detail}: RTNETLINK answers: ${errno === "EEXIST" ? "File exists" : "No such process"}`,
		);
	}
}

const value = (row: string, key: string) =>
	new RegExp(`\\b${key} (\\S+)`).exec(row)?.[1];
const priority = (row: string, family: 4 | 6) =>
	Number(value(row, "metric") ?? (family === 6 ? 1024 : 0));
const realm = (row: string) => {
	const [from, to] = (value(row, "realm") ?? value(row, "realms") ?? "0")
		.split("/")
		.map(Number);
	return to === undefined ? from : (from ?? 0) * 65536 + to;
};

/** Mutable kernel-table fake: exact argv replay, no module or command mocks. */
export class DefaultRouteTable {
	readonly routes = new Map<4 | 6, Set<string>>();
	readonly mutations: string[][] = [];
	failMutation = 0;

	constructor(
		v4: readonly string[],
		v6: readonly string[] = [],
		readonly mode: "board" | "host" = "board",
	) {
		const stored = (row: string) =>
			this.mode === "board"
				? row.replace(/\b(?:realm|realms|classid) \S+\s*/g, "").trim()
				: row;
		this.routes.set(4, new Set(v4.map(stored)));
		this.routes.set(6, new Set(v6.map(stored)));
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
			return this.orderedRows(family).join("\n");
		}
		if (verb === "get") {
			return this.orderedRows(family)[0] ?? "";
		}
		this.mutations.push(args);
		if (this.mutations.length === this.failMutation)
			throw new Error("injected mutation failure");
		const row = args
			.slice(start + 2)
			.join(" ")
			.replace(
				this.mode === "board" ? /\b(?:realm|realms|classid) \S+\s*/g : /$^/g,
				"",
			)
			.trim();
		if (/\b(linkdown|dead)\b/.test(row))
			throw new Error("display flag is garbage");
		switch (verb) {
			case "prepend": {
				if (
					[...table].some((existing) =>
						this.sameIdentity(existing, row, family),
					)
				)
					throw new KernelRouteCommandError("EEXIST", "route exists");
				if (family === 6) {
					const existing = [...table].find(
						(entry) => priority(entry, family) === priority(row, family),
					);
					if (existing) {
						table.delete(existing);
						table.add(
							`default proto ${value(existing, "proto")} metric ${priority(row, family)} pref medium\n\tnexthop via ${value(existing, "via")} dev ${value(existing, "dev")} weight 1\n\tnexthop via ${value(row, "via")} dev ${value(row, "dev")} weight 1`,
						);
						break;
					}
				}
				const previous = [...table];
				table.clear();
				table.add(row);
				for (const existing of previous) table.add(existing);
				break;
			}
			case "add":
			case "append":
				if (
					[...table].some((existing) =>
						verb === "add"
							? priority(existing, family) === priority(row, family)
							: this.sameIdentity(existing, row, family),
					)
				)
					throw new KernelRouteCommandError("EEXIST", "route exists");
				table.add(row);
				break;
			case "del":
				{
					const existing = [...table].find(
						(entry) =>
							["via", "dev", "src", "proto"].every(
								(key) =>
									value(row, key) === undefined ||
									value(entry, key) === value(row, key),
							) &&
							(value(row, "metric") === undefined ||
								priority(entry, family) === priority(row, family)) &&
							(this.mode === "board" ||
								realm(row) === 0 ||
								realm(entry) === realm(row)),
					);
					if (existing === undefined)
						throw new KernelRouteCommandError("ESRCH", "route absent");
					table.delete(existing);
				}
				break;
			default:
				throw new Error(`unsupported fixture operation: ${verb}`);
		}
		return "";
	};

	private sameIdentity(a: string, b: string, family: 4 | 6): boolean {
		return (
			["via", "dev", "src", "proto"].every(
				(key) => value(a, key) === value(b, key),
			) &&
			priority(a, family) === priority(b, family) &&
			(this.mode === "board" || realm(a) === realm(b)) &&
			a.includes("onlink") === b.includes("onlink")
		);
	}

	rows(family: 4 | 6 = 4): string[] {
		return [...(this.routes.get(family) ?? [])].sort();
	}

	orderedRows(family: 4 | 6 = 4): string[] {
		return [...(this.routes.get(family) ?? [])].sort(
			(a, b) => priority(a, family) - priority(b, family),
		);
	}
}
