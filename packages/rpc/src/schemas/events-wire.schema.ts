/**
 * Boot-safe event wire shapes. Keep the typed registry out of this module and
 * the schemas barrel so an unopened timeline costs the initial route nothing.
 */
import { z } from 'zod';
import { versionContextSchema } from './logs.schema';

export const EVENT_FAMILIES = [
	'stream',
	'network',
	'cellular',
	'update',
	'device',
	'capture',
] as const;
export const EVENT_SEVERITIES = ['error', 'warning', 'info', 'success'] as const;
export const EVENT_PUSH = 'event';
export const LOW_DISK_THRESHOLD_BYTES = 512 * 1024 * 1024;

export const eventFamilySchema = z.enum(EVENT_FAMILIES);
export type EventFamily = z.infer<typeof eventFamilySchema>;
export const eventSeveritySchema = z.enum(EVENT_SEVERITIES);
export type EventSeverity = z.infer<typeof eventSeveritySchema>;

const bootIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
const eventParamValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
	z.array(z.string()),
]);

// Older readers must retain new codes and flat params, even after a rollback.
export const deviceEventSchema = z.object({
	id: z.string(),
	seq: z.number().int(),
	bootId: z.string(),
	at: z.number(),
	code: z.string(),
	family: eventFamilySchema.catch('device'),
	severity: eventSeveritySchema.catch('info'),
	params: z.record(z.string(), eventParamValueSchema),
	suppressed: z.number().int().optional(),
});
export type DeviceEvent = z.infer<typeof deviceEventSchema>;

export const eventListInputSchema = z.strictObject({
	beforeSeq: z.number().int().optional(),
	limit: z.number().int().min(1).max(200).default(100),
	bootId: bootIdSchema.optional(),
	families: z.array(eventFamilySchema).optional(),
	problemsOnly: z.boolean().optional(),
});
export type EventListInput = z.input<typeof eventListInputSchema>;

// The event ring's identity: kept while its records are, replaced by a clear,
// after which seq and event ids can start again from 1.
export const eventRingEpochSchema = z.uuid();

export const eventListOutputSchema = z.strictObject({
	events: z.array(deviceEventSchema),
	nextBeforeSeq: z.number().int().nullable(),
	headSeq: z.number().int(),
	retainedFromSeq: z.number().int(),
	// When absent, refresh or validate the visible window without losing paging.
	// A changed epoch identifies a history clear.
	epoch: eventRingEpochSchema.optional(),
});
export type EventListOutput = z.infer<typeof eventListOutputSchema>;

// Boot records live independently of cleared events and keep nested versions.
export const eventBootRecordSchema = z.strictObject({
	bootId: bootIdSchema,
	startedAt: z.number(),
	versions: versionContextSchema.nullable(),
});
export type EventBootRecord = z.infer<typeof eventBootRecordSchema>;
export const eventBootsOutputSchema = z.array(eventBootRecordSchema);

export const eventAppendSchema = z.strictObject({
	append: z.array(deviceEventSchema),
});
export type EventAppend = z.infer<typeof eventAppendSchema>;
