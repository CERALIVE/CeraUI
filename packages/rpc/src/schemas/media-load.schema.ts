import { z } from 'zod';

/** The creating task's PID and driver session index, not an engine session ID. */
export const mppSessionOwnerSchema = z.object({
	pid: z.number().int().positive(),
	index: z.number().int().nonnegative(),
});
export type MppSessionOwner = z.infer<typeof mppSessionOwnerSchema>;

export const mppBlockSchema = z.enum(['rkvenc', 'rkvdec', 'jpgdec']);
export type MppBlock = z.infer<typeof mppBlockSchema>;

export const mediaCoreLoadSchema = z.object({
	/** MPP dev_name or RGA scheduler identity; never a position in the wire array. */
	core: z.string().min(1),
	/** Raw driver percentages. MPP multicore queue accounting can exceed 100. */
	load: z.number().nonnegative().nullable(),
	utilization: z.number().nonnegative().nullable(),
	/** Bound-device ownership, not executing-core attribution. null means unknown. */
	sessions: z.array(mppSessionOwnerSchema).nullable(),
});
export type MediaCoreLoad = z.infer<typeof mediaCoreLoadSchema>;

export const mediaBlockLoadSchema = z.discriminatedUnion('source', [
	z.object({
		source: z.literal('mpp-service'),
		block: mppBlockSchema,
		cores: z.array(mediaCoreLoadSchema).min(1),
	}),
	z.object({
		source: z.literal('rkrga'),
		block: z.literal('rga'),
		cores: z
			.array(
				mediaCoreLoadSchema.extend({
					load: z.number().min(0).max(100).nullable(),
					utilization: z.null(),
					sessions: z.null(),
				}),
			)
			.min(1),
	}),
]);
export type MediaBlockLoad = z.infer<typeof mediaBlockLoadSchema>;
