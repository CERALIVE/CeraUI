import {
	type LogAroundInput,
	type LogAroundOutput,
	type LogQueryInput,
	type LogQueryOutput,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import { locatePagesAround } from "./around.ts";
import { currentBootId } from "./boot-id.ts";
import { listBoots } from "./boots.ts";
import { withQuerySlot } from "./query-admission.ts";
import { JournalReadError } from "./reader.ts";
import { scanPage } from "./scan-page.ts";
import { getLogState } from "./settings.ts";

export { abortLogQueries } from "./query-admission.ts";

export async function queryLogs(
	conn: object,
	input: LogQueryInput,
): Promise<LogQueryOutput> {
	const query = logQueryInputSchema.parse(input);
	try {
		return await withQuerySlot(conn, async (signal) => {
			const bootId =
				query.boot === "all"
					? null
					: query.boot === "current"
						? currentBootId()
						: query.boot;
			if (
				bootId === undefined ||
				(query.boot !== "current" &&
					bootId !== null &&
					!(await listBoots()).some(
						(boot) => boot.bootId === bootId && boot.logsAvailable,
					))
			)
				return { ok: false, error: "BOOT_UNAVAILABLE" } as const;
			return scanPage(query, {
				bootId,
				epoch: getLogState().historyEpoch,
				signal,
			});
		});
	} catch (error) {
		if (error instanceof JournalReadError)
			return { ok: false, error: error.code };
		throw error;
	}
}

export async function locateAround(
	conn: object,
	input: LogAroundInput,
): Promise<LogAroundOutput> {
	try {
		return await withQuerySlot(conn, async (signal) => {
			if (
				!(await listBoots()).some(
					(boot) => boot.bootId === input.bootId && boot.logsAvailable,
				)
			)
				return { ok: false, error: "BOOT_UNAVAILABLE" } as const;
			return locatePagesAround(input, {
				signal,
				epoch: getLogState().historyEpoch,
			});
		});
	} catch (error) {
		if (error instanceof JournalReadError)
			return { ok: false, error: error.code };
		throw error;
	}
}
