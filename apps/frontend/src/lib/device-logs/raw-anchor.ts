/** The boundary from a frontend message's moment to its device log window. */
import {
	type LogAroundInput,
	type LogAroundOutput,
	logAroundOutputSchema,
	logBootInfoSchema,
	logQueryWithoutContinuationSchema,
} from "@ceraui/rpc/schemas";

// Input defaults must not turn a partial reply into a different boot or filter.
const queryShape = logQueryWithoutContinuationSchema.shape;
const queryReply = logQueryWithoutContinuationSchema.safeExtend({
	sources: queryShape.sources.unwrap(),
	levels: queryShape.levels.unwrap(),
	boot: queryShape.boot.unwrap(),
	direction: queryShape.direction.unwrap(),
	limit: queryShape.limit.unwrap(),
});
const aroundReply = logAroundOutputSchema.options[0]
	.safeExtend({ olderQuery: queryReply, newerQuery: queryReply })
	.or(logAroundOutputSchema.options[1]);

interface Logs {
	boots(): Promise<unknown>;
	around(input: LogAroundInput): Promise<unknown>;
}

export interface RawAnchor {
	readonly at: number;
	readonly bootId?: string;
}

export async function locateAround(
	logs: Logs,
	request: RawAnchor,
	signal: AbortSignal = new AbortController().signal,
): Promise<LogAroundOutput | null> {
	try {
		let bootId = request.bootId;
		if (bootId === undefined) {
			const reply = await logs.boots();
			if (signal.aborted) return null;
			bootId = logBootInfoSchema
				.array()
				.parse(reply)
				.find((boot) => boot.current)?.bootId;
		}
		if (bootId === undefined) {
			console.error("System Logs could not find the running boot.");
			return { ok: false, error: "READ_FAILED" };
		}
		const reply = await logs.around({ bootId, at: request.at });
		if (signal.aborted) return null;
		return aroundReply.parse(reply);
	} catch (error) {
		if (signal.aborted) return null;
		console.error("System Logs could not open the message's raw logs:", error);
		return { ok: false, error: "READ_FAILED" };
	}
}
