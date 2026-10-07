import type { run } from "../../helpers/run.ts";
import { logParseError, parseFail } from "../system/cli-parse.ts";
import {
	type DefaultRoute,
	GatewayRouteError,
	HOST_ROUTE_PROTOCOLS,
	readDefaultRoutes,
} from "./default-route-model.ts";

export type GwDeps = {
	readonly runner: typeof run;
	readonly family: 4 | 6;
};

export type OwnedDefaultRoute = DefaultRoute & {
	readonly restore: "add" | "prepend" | "append" | undefined;
};

export function parseRouteInventory(
	output: string,
	family: 4 | 6,
): DefaultRoute[] {
	try {
		return readDefaultRoutes(output, family);
	} catch (error) {
		if (error instanceof GatewayRouteError)
			logParseError(
				parseFail(
					"parseDefaultRouteLine",
					"invalid default-route output",
					output,
				),
			);
		throw error;
	}
}

export async function readOwnedInventory(runner: typeof run): Promise<{
	readonly owned: readonly OwnedDefaultRoute[];
	readonly foreign: ReadonlyMap<4 | 6, string>;
	readonly failures: readonly unknown[];
}> {
	const owned: OwnedDefaultRoute[] = [];
	const foreign = new Map<4 | 6, string>();
	const failures: unknown[] = [];
	for (const family of [4, 6] as const) {
		let output: string;
		try {
			output = await runner("ip", [
				...(family === 6 ? ["-6"] : []),
				"-N",
				"route",
				"show",
				"default",
			]);
		} catch (error) {
			failures.push(error);
			continue;
		}
		// Keep a multipath header with its continuation lines; cleanup parses only owned records.
		const records = output.trim() ? output.trim().split(/\n(?=\S)/) : [];
		const isOwned = (record: string) =>
			new RegExp(
				`^default\\b.*\\bproto (?:${HOST_ROUTE_PROTOCOLS.join("|")})(?:\\s|$)`,
			).test(record.split("\n")[0] ?? "");
		const metrics = records.map((record) => {
			const tokens = record.split("\n")[0]?.split(/\s+/) ?? [];
			const index = tokens.indexOf("metric");
			return index < 0 ? (family === 6 ? 1024 : 0) : Number(tokens[index + 1]);
		});
		for (const [index, record] of records.entries()) {
			if (!isOwned(record)) continue;
			let routes: DefaultRoute[];
			try {
				routes = parseRouteInventory(record, family);
			} catch (error) {
				failures.push(error);
				continue;
			}
			for (const route of routes) {
				const peers = records.filter(
					(_, peer) => metrics[peer] === route.metric,
				);
				const position = records
					.slice(0, index)
					.filter((_, peer) => metrics[peer] === route.metric).length;
				// Endpoints can be restored without rewriting foreign equal-metric anchors.
				const restore = metrics.some((metric) => !Number.isInteger(metric))
					? undefined
					: peers.length === 1
						? "add"
						: family === 6 || peers.filter(isOwned).length !== 1
							? undefined
							: position === 0
								? "prepend"
								: position === peers.length - 1
									? "append"
									: undefined;
				owned.push({ ...route, restore });
			}
		}
		foreign.set(
			family,
			records.filter((record) => !isOwned(record)).join("\n"),
		);
	}
	return { owned, foreign, failures };
}
