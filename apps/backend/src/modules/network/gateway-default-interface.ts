import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { parseDefaultRouteInterface } from "./connectivity-candidates.ts";

export async function resolveDefaultRouteInterface(
	family: 4 | 6,
): Promise<string | undefined> {
	try {
		return parseDefaultRouteInterface(
			await run("ip", [
				...(family === 6 ? ["-6"] : []),
				"route",
				"show",
				"default",
			]),
		);
	} catch (cause) {
		const error =
			cause instanceof Error
				? cause
				: new Error("Default-route observation rejected", { cause });
		logger.debug("Could not read the default route", { error });
		return undefined;
	}
}
