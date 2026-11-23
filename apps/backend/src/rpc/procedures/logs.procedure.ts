import {
	logAroundInputSchema,
	logAroundOutputSchema,
	logBootInfoSchema,
	logBundleManifestSchema,
	logClearAllOutputSchema,
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
import { BOUNDED_SPAWN_TERM_GRACE_MS } from "../../helpers/bounded-spawn.ts";
import {
	createBundle,
	previewBundle,
} from "../../modules/device-logs/bundle.ts";
import { listBoots } from "../../modules/device-logs/classified-boots.ts";
import { createExport } from "../../modules/device-logs/export.ts";
import { exportCredentialPolicy } from "../../modules/device-logs/export-redaction.ts";
import { startFollow, stopFollow } from "../../modules/device-logs/follow.ts";
import { locateAround, queryLogs } from "../../modules/device-logs/query.ts";
import { JOURNAL_LIMITS } from "../../modules/device-logs/reader.ts";
import { BundleReadError } from "../../modules/device-logs/redaction.ts";
import {
	clearAll,
	deleteLegacyDebug,
	getStorage,
	setRetention,
} from "../../modules/device-logs/retention.ts";
import { socketSessionSignal } from "../context.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";

const authedProcedure = os.$context<RPCContext>().use(authMiddleware);
const SLOT_WAIT_MS =
	JOURNAL_LIMITS.deadlineMs + BOUNDED_SPAWN_TERM_GRACE_MS + 1000;

function slotAdmission(ws: AppWebSocket, signal?: AbortSignal) {
	const session = socketSessionSignal(ws);
	return {
		interactive: signal ? AbortSignal.any([session, signal]) : session,
		timeoutMs: SLOT_WAIT_MS,
	};
}

export const queryLogsProcedure = authedProcedure
	.input(logQueryInputSchema)
	.output(logQueryOutputSchema)
	.handler(({ context, input, signal }) =>
		queryLogs(context.ws, input, slotAdmission(context.ws, signal)),
	);

export const aroundLogsProcedure = authedProcedure
	.input(logAroundInputSchema)
	.output(logAroundOutputSchema)
	.handler(({ context, input, signal }) =>
		locateAround(context.ws, input, slotAdmission(context.ws, signal)),
	);

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

export const deleteLegacyDebugProcedure = authedProcedure
	.output(logStorageOutputSchema)
	.handler(() => deleteLegacyDebug());

export const clearAllLogsProcedure = authedProcedure
	.output(logClearAllOutputSchema)
	.handler(() => clearAll());

export const createLogExportProcedure = authedProcedure
	.input(logExportInputSchema)
	.output(logExportOutputSchema)
	.handler(({ context, input, signal }) => {
		const credentials = exportCredentialPolicy();
		if (!credentials.ok) {
			const reason =
				credentials.error === "READ_FAILED"
					? "CREDENTIAL_READ_FAILED"
					: credentials.error;
			throw new ORPCError(reason, { message: reason });
		}
		return createExport(context.ws, input, signal);
	});

export const previewLogBundleProcedure = authedProcedure
	.input(z.void())
	.output(logBundleManifestSchema)
	.handler(async ({ signal }) => {
		try {
			return await previewBundle(signal);
		} catch (error) {
			const code =
				error instanceof BundleReadError ? error.code : "READ_FAILED";
			throw new ORPCError(code, { message: code });
		}
	});

export const createLogBundleProcedure = authedProcedure
	.input(z.void())
	.output(logExportOutputSchema)
	.handler(({ context, signal }) => createBundle(context.ws, signal));
