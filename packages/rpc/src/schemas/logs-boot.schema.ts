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
