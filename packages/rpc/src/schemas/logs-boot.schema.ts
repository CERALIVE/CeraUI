import { z } from 'zod';
import { bootIdSchema, countSchema, timestampSchema } from './logs-fields';

export const versionContextSchema = z.strictObject({
	bootId: bootIdSchema,
	osImage: z.string().nullable(),
	slot: z.string().nullable(),
	board: z.string().nullable(),
	boardModel: z.string().nullable(),
	ceraui: z.string(),
	engine: z.string().nullable(),
	// The logger reserves "sender" for sensitive SMS data.
	senderVersion: z.string().nullable(),
	kernel: z.string().nullable(),
	bun: z.string().nullable(),
});
export type VersionContext = z.infer<typeof versionContextSchema>;
export const logBootInfoSchema = z.strictObject({
	bootId: bootIdSchema,
	index: z.number().int(),
	firstTs: timestampSchema,
	lastTs: timestampSchema,
	current: z.boolean(),
	shutdown: z.enum(['clean', 'unclean', 'unknown', 'current']),
	evidence: z.array(z.string()),
	logsAvailable: z.boolean(),
	versions: versionContextSchema.nullable(),
});
export type LogBootInfo = z.infer<typeof logBootInfoSchema>;

export const logBundleSectionIdSchema = z.enum(['versions', 'events', 'journal', 'settings']);
const bundleSectionCounts = { entries: countSchema, redactions: countSchema };

export const logBundleManifestSchema = z.strictObject({
	sections: z.array(
		z.discriminatedUnion('id', [
			z.strictObject({
				id: logBundleSectionIdSchema.exclude(['journal']),
				...bundleSectionCounts,
			}),
			z.strictObject({
				id: logBundleSectionIdSchema.extract(['journal']),
				...bundleSectionCounts,
				bootsCovered: countSchema,
				complete: z.boolean(),
			}),
		]),
	),
	exportedBy: versionContextSchema,
	boots: z.array(
		z.strictObject({
			bootId: bootIdSchema,
			versions: versionContextSchema.nullable(),
		}),
	),
});
export type LogBundleManifest = z.infer<typeof logBundleManifestSchema>;

/**
 * Where a bundle preview stopped with READ_FAILED: a closed stage, never a
 * cause or input. It rides the error envelope's optional `stage` beside the
 * unchanged `READ_FAILED` message that older clients match exactly.
 */
export const logBundleFailureReasonSchema = z.enum([
	'collision',
	'pattern',
	'budget',
	'journal_read',
	'deadline',
	'abort',
	'internal',
]);
export type LogBundleFailureReason = z.infer<typeof logBundleFailureReasonSchema>;
