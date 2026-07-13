import { call } from "@orpc/server";

import {
	getConfigProcedure,
	getPipelinesProcedure,
	setBitrateProcedure,
	setConfigProcedure,
	streamingStartProcedure,
	streamingStopProcedure,
} from "../../rpc/procedures/streaming.procedure.ts";
import type { RPCContext } from "../../rpc/types.ts";
import type { Command } from "./protocol.ts";

export type ProcedureDispatcher = (
	frame: Command,
	context: RPCContext,
) => Promise<unknown>;

function toMaxKilobitrateInput(payload: Command["payload"]): {
	readonly max_br: number;
} {
	const bps = payload?.bitrate_bps;
	return {
		max_br: typeof bps === "number" ? Math.round(bps / 1000) : Number.NaN,
	};
}

export const STREAMING_DISPATCH: Record<string, ProcedureDispatcher> = {
	"streaming.start": (frame, context) =>
		call(streamingStartProcedure, frame.payload ?? {}, { context }),
	"streaming.stop": (_frame, context) =>
		call(streamingStopProcedure, undefined, { context }),
	"streaming.setBitrate": (frame, context) =>
		call(setBitrateProcedure, toMaxKilobitrateInput(frame.payload), {
			context,
		}),
	"streaming.setConfig": (frame, context) =>
		call(setConfigProcedure, frame.payload ?? {}, { context }),
	"streaming.getConfig": (_frame, context) =>
		call(getConfigProcedure, undefined, { context }),
	"streaming.getPipelines": (_frame, context) =>
		call(getPipelinesProcedure, undefined, { context }),
};
