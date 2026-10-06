import type { run } from "../../helpers/run.ts";
import { logParseError, parseFail } from "../system/cli-parse.ts";
import {
	type DefaultRoute,
	GatewayRouteError,
	HOST_ROUTE_PROTOCOL,
	readDefaultRoutes,
} from "./default-route-model.ts";

export type GwDeps = {
	readonly runner: typeof run;
	readonly family: 4 | 6;
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
	readonly owned: readonly DefaultRoute[];
	readonly foreign: ReadonlyMap<4 | 6, string>;
}> {
	const owned: DefaultRoute[] = [];
	const foreign = new Map<4 | 6, string>();
	for (const family of [4, 6] as const) {
		const output = await runner("ip", [
			...(family === 6 ? ["-6"] : []),
			"-N",
			"route",
			"show",
			"default",
		]);
		// Keep a multipath header with its continuation lines; cleanup parses only owned records.
		const records = output.trim() ? output.trim().split(/\n(?=\S)/) : [];
		const isOwned = (record: string) =>
			new RegExp(`^default\\b.*\\bproto ${HOST_ROUTE_PROTOCOL}(?:\\s|$)`).test(
				record.split("\n")[0] ?? "",
			);
		owned.push(
			...parseRouteInventory(records.filter(isOwned).join("\n"), family),
		);
		foreign.set(
			family,
			records.filter((record) => !isOwned(record)).join("\n"),
		);
	}
	return { owned, foreign };
}
