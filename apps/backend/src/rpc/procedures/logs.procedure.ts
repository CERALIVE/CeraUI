import {
	logAroundInputSchema,
	logAroundOutputSchema,
	logBootInfoSchema,
	logBundleManifestSchema,
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
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import {
	createBundle,
	previewBundle,
} from "../../modules/device-logs/bundle.ts";
import { listBoots } from "../../modules/device-logs/classified-boots.ts";
import { createExport } from "../../modules/device-logs/export.ts";
import { startFollow, stopFollow } from "../../modules/device-logs/follow.ts";
import { locateAround, queryLogs } from "../../modules/device-logs/query.ts";
import { BundleReadError } from "../../modules/device-logs/redaction.ts";
import {
	clearAll,
	deleteLegacyDebug,
	deleteOlderFiles,
	getStorage,
	setRetention,
} from "../../modules/device-logs/retention.ts";
import { socketSessionSignal } from "../context.ts";
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
	.use(({ context, next }) =>
		next({ context: { sessionSignal: socketSessionSignal(context.ws) } }),
	)
	.input(logFollowStartInputSchema)
	.output(logFollowStartOutputSchema)
	.handler(({ context, input }) =>
		startFollow(context.ws, input, { sessionSignal: context.sessionSignal }),
	);

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

export const previewLogBundleProcedure = authedProcedure
	.input(z.void())
	.output(logBundleManifestSchema)
	.handler(async () => {
		try {
			return await previewBundle();
		} catch (error) {
			const code =
				error instanceof BundleReadError ? error.code : "READ_FAILED";
			throw new ORPCError(code, { message: code });
		}
	});

export const createLogBundleProcedure = authedProcedure
	.input(z.void())
	.output(logExportOutputSchema)
	.handler(({ context }) => createBundle(context.ws));
