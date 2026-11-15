import {
	logAroundInputSchema,
	logAroundOutputSchema,
	logBootInfoSchema,
	logDeleteOlderFilesOutputSchema,
	logExportInputSchema,
	logExportOutputSchema,
	logFollowStartInputSchema,
	logFollowStartOutputSchema,
	logFollowStopOutputSchema,
	logQueryInputSchema,
	logQueryOutputSchema,
	logRetentionSchema,
	logStorageOutputSchema,
	logStorageSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { z } from "zod";
import { listBoots } from "../../modules/device-logs/classified-boots.ts";
import { createExport } from "../../modules/device-logs/export.ts";
import { startFollow, stopFollow } from "../../modules/device-logs/follow.ts";
import { locateAround, queryLogs } from "../../modules/device-logs/query.ts";
import {
	clearAll,
	deleteLegacyDebug,
	deleteOlderFiles,
	getStorage,
	setRetention,
} from "../../modules/device-logs/retention.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

const authedProcedure = os.$context<RPCContext>().use(authMiddleware);

export const queryLogsProcedure = authedProcedure
	.input(logQueryInputSchema)
	.output(logQueryOutputSchema)
	.handler(({ context, input }) => queryLogs(context.ws, input));

export const aroundLogsProcedure = authedProcedure
	.input(logAroundInputSchema)
	.output(logAroundOutputSchema)
	.handler(({ context, input }) => locateAround(context.ws, input));

export const logBootsProcedure = authedProcedure
	.output(z.array(logBootInfoSchema))
	.handler(() => listBoots());

export const followStartProcedure = authedProcedure
	.input(logFollowStartInputSchema)
	.output(logFollowStartOutputSchema)
	.handler(({ context, input }) => startFollow(context.ws, input));

export const followStopProcedure = authedProcedure
	.output(logFollowStopOutputSchema)
	.handler(({ context }) => stopFollow(context.ws));

export const getLogStorageProcedure = authedProcedure
	.output(logStorageSchema)
	.handler(() => getStorage());

export const setLogRetentionProcedure = authedProcedure
	.input(logRetentionSchema)
	.output(logStorageOutputSchema)
	.handler(({ input }) => setRetention(input));

export const deleteOlderLogFilesProcedure = authedProcedure
	.output(logDeleteOlderFilesOutputSchema)
	.handler(() => deleteOlderFiles());

export const deleteLegacyDebugProcedure = authedProcedure
	.output(logStorageOutputSchema)
	.handler(() => deleteLegacyDebug());

export const clearAllLogsProcedure = authedProcedure
	.output(logStorageOutputSchema)
	.handler(() => clearAll());

export const createLogExportProcedure = authedProcedure
	.input(logExportInputSchema)
	.output(logExportOutputSchema)
	.handler(({ context, input }) => createExport(context.ws, input));
