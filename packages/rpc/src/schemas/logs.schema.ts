/**
 * Device log wire shapes. Journal access and image retention ceilings belong to
 * the backend; these declarations remain safe to import in the browser.
 */
import { z } from 'zod';
import { bootIdSchema, countSchema, timestampSchema } from './logs-fields';

export * from './logs-boot.schema';

export const LOG_SOURCES = [
	'app',
	'engine',
	'bonding',
	'network',
	'cellular',
	'updates',
	'device',
	'kernel',
] as const;
export const LOG_LEVELS = ['error', 'warning', 'info', 'debug'] as const;
export const LOG_ERROR_CODES = [
	'CURSOR_UNAVAILABLE',
	'BOOT_UNAVAILABLE',
	'FILTER_CHANGED',
	'JOURNAL_UNAVAILABLE',
	'BUSY',
	'RECORD_TOO_LARGE',
	'READ_FAILED',
	'INVALID_RETENTION',
	'UPDATE_IN_PROGRESS',
] as const;
export const LOG_FOLLOW_EVENT = 'logs.follow';
export const LOG_FOLLOW_GAP_FROM = 'logs.follow.gapFrom';
export const LOG_FOLLOW_BOOT_START_PREFIX = 'boot-start:';

export function journalCursorBoot(cursor: string): string | undefined {
	return /(?:^|;)b=([0-9a-f]{32})(?:;|$)/.exec(cursor)?.[1];
}

export const logSourceSchema = z.enum(LOG_SOURCES);
export type LogSource = z.infer<typeof logSourceSchema>;
export const logLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof logLevelSchema>;
export const logErrorCodeSchema = z.enum(LOG_ERROR_CODES);
export type LogErrorCode = z.infer<typeof logErrorCodeSchema>;
export const logErrorSchema = z.strictObject({
	ok: z.literal(false),
	error: logErrorCodeSchema,
});

const continuationSchema = z
	.string()
	.max(2048)
	.regex(/^[A-Za-z0-9_-]+$/);
const followCursorSchema = z
	.string()
	.max(1024)
	.regex(/^[A-Za-z0-9=;:_.-]+$/);
const timeRangeShape = {
	since: timestampSchema.optional(),
	until: timestampSchema.optional(),
};
const orderedTimeRange = ({
	since,
	until,
}: {
	readonly since?: number | undefined;
	readonly until?: number | undefined;
}): boolean => since === undefined || until === undefined || until > since;
const timeRangeError = { message: 'until must be greater than since', path: ['until'] };

export const logFilterSchema = z.strictObject({
	// Empty sources means all sources, including records without a known source.
	sources: z.array(logSourceSchema).default([]),
	levels: z
		.array(logLevelSchema)
		.min(1)
		.default([...LOG_LEVELS]),
	text: z
		.string()
		.min(1)
		.refine((text) => new TextEncoder().encode(text).byteLength <= 256, {
			message: 'text must be at most 256 UTF-8 bytes',
		})
		.refine((text) => !text.includes('\0'), { message: 'text must not contain NUL' })
		.optional(),
});
export type LogFilter = z.input<typeof logFilterSchema>;

export const logBootSchema = z.union([z.literal('current'), z.literal('all'), bootIdSchema]);
export type LogBoot = z.infer<typeof logBootSchema>;

// Around-page queries deliberately cannot carry a continuation of their own.
export const logQueryWithoutContinuationSchema = z
	.strictObject({
		...logFilterSchema.shape,
		...timeRangeShape,
		boot: logBootSchema.default('current'),
		direction: z.enum(['older', 'newer']).default('older'),
		limit: z.number().int().min(1).max(200).default(100),
	})
	.refine(orderedTimeRange, timeRangeError);
export const logQueryInputSchema = logQueryWithoutContinuationSchema.safeExtend({
	continuation: continuationSchema.optional(),
});
export type LogQueryInput = z.input<typeof logQueryInputSchema>;

export const logEntrySchema = z.strictObject({
	cursor: z.string(),
	ts: timestampSchema,
	bootId: bootIdSchema,
	level: logLevelSchema,
	source: logSourceSchema.nullable(),
	unit: z.string(),
	message: z.string(),
	truncated: z.boolean(),
	marker: z.literal('suppressed').nullable(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const logQueryPageSchema = z.strictObject({
	ok: z.literal(true),
	entries: z.array(logEntrySchema),
	hasMore: z.boolean().nullable(),
	termination: z.enum(['lookahead', 'end', 'budget']),
	continuation: continuationSchema.nullable(),
	historyEpoch: countSchema,
	bootId: bootIdSchema.nullable(),
});
export type LogQueryPage = z.infer<typeof logQueryPageSchema>;
export const logQueryOutputSchema = z.discriminatedUnion('ok', [
	logQueryPageSchema,
	logErrorSchema,
]);
export type LogQueryOutput = z.infer<typeof logQueryOutputSchema>;

export const logFollowStartInputSchema = z.strictObject({
	...logFilterSchema.shape,
	afterCursor: followCursorSchema.optional(),
});
export type LogFollowStartInput = z.input<typeof logFollowStartInputSchema>;
export const logFollowStartOutputSchema = z.discriminatedUnion('ok', [
	z.strictObject({
		ok: z.literal(true),
		subscriptionId: z.string(),
		checkpointCursor: z.string().nullable(),
	}),
	logErrorSchema,
]);
export type LogFollowStartOutput = z.infer<typeof logFollowStartOutputSchema>;
export const logFollowStopOutputSchema = z.strictObject({
	success: z.boolean(),
	checkpointCursor: z.string().nullable(),
});
export type LogFollowStopOutput = z.infer<typeof logFollowStopOutputSchema>;
export const logFollowMessageSchema = z.strictObject({
	subscriptionId: z.string(),
	entries: z.array(logEntrySchema),
	checkpointCursor: z.string().nullable(),
	dropped: countSchema,
	gap: z.enum(['catchup_exceeded', 'cursor_unavailable', 'suppressed']).optional(),
	gapFrom: continuationSchema.optional(),
	ended: z.enum(['follower_exit', 'boot_changed', 'cleared']).optional(),
});
export type LogFollowMessage = z.infer<typeof logFollowMessageSchema>;

export const logRetentionSchema = z.strictObject({
	maxAgeDays: z.number().int().min(1).nullable(),
	maxSizeMb: z.number().int().min(16).nullable(),
	detail: z.enum(['debug', 'info']),
});
export type LogRetention = z.input<typeof logRetentionSchema>;
export const logStorageSchema = z.strictObject({
	journalBytes: z.number().nonnegative().nullable(),
	journalDirBytes: z.number().nonnegative().nullable(),
	legacyDebugBytes: z.number().nonnegative(),
	ceiling: z
		.strictObject({
			maxSizeMb: z.number().int().positive(),
			maxAgeDays: z.number().int().positive(),
		})
		.nullable(),
	retention: logRetentionSchema,
	oldestEntryTs: timestampSchema.nullable(),
	recentVolume: z.array(
		z.strictObject({
			source: logSourceSchema.nullable(),
			entries: countSchema,
			bytes: countSchema,
		}),
	),
	recentSample: countSchema,
	eventsBytes: z.number().nonnegative(),
	lastMaintenance: z
		.strictObject({
			at: timestampSchema,
			ok: z.boolean(),
			targetMet: z.boolean(),
		})
		.nullable(),
	lastClearedAt: timestampSchema.nullable(),
});
export type LogStorage = z.infer<typeof logStorageSchema>;
export const logStorageOutputSchema = z.discriminatedUnion('ok', [
	z.strictObject({ ok: z.literal(true), storage: logStorageSchema }),
	logErrorSchema,
]);
export type LogStorageOutput = z.infer<typeof logStorageOutputSchema>;
export const logDeleteOlderFilesOutputSchema = z.discriminatedUnion('ok', [
	z.strictObject({
		ok: z.literal(true),
		storage: logStorageSchema,
		bootsBefore: countSchema,
		bootsAfter: countSchema,
	}),
	logErrorSchema,
]);
export type LogDeleteOlderFilesOutput = z.infer<typeof logDeleteOlderFilesOutputSchema>;

export const logExportInputSchema = z
	.strictObject({
		filter: logFilterSchema,
		boot: logBootSchema.default('current'),
		...timeRangeShape,
	})
	.refine(orderedTimeRange, timeRangeError);
export type LogExportInput = z.input<typeof logExportInputSchema>;
export const logExportOutputSchema = z.discriminatedUnion('ok', [
	z.strictObject({
		ok: z.literal(true),
		url: z.string(),
		expiresAt: timestampSchema,
	}),
	logErrorSchema,
]);
export type LogExportOutput = z.infer<typeof logExportOutputSchema>;

export const logAroundInputSchema = z.strictObject({
	bootId: bootIdSchema,
	at: timestampSchema,
	eventId: z
		.string()
		.max(64)
		.regex(/^[A-Za-z0-9-]+$/)
		.optional(),
});
export type LogAroundInput = z.input<typeof logAroundInputSchema>;
export const logAroundOutputSchema = z.discriminatedUnion('ok', [
	z.strictObject({
		ok: z.literal(true),
		anchor: logEntrySchema.nullable(),
		approximate: z.boolean(),
		older: logQueryPageSchema,
		newer: logQueryPageSchema,
		olderQuery: logQueryWithoutContinuationSchema,
		newerQuery: logQueryWithoutContinuationSchema,
	}),
	logErrorSchema,
]);
export type LogAroundOutput = z.infer<typeof logAroundOutputSchema>;
