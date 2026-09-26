/**
 * `system.getUpdateDetails` (Todo 41) — the Updates dialog's pull for every
 * fact the `update_orchestrator` status push deliberately does not carry.
 *
 * Every block is independently nullable so one unreadable source never blanks
 * the dialog, and `null` always means "not established" — never a healthy
 * default. The slot shape is the backend's existing `RootSlotStatus` read
 * (`update-orchestrator/slot-status.ts`), projected verbatim; it is a separate,
 * additive read and never widens the S1-locked `device-stats.raucSlot` scalar.
 */
import { z } from 'zod';

/** One RAUC root-filesystem slot, as `rauc status` + the sync receipt describe it. */
export const updateSlotStatusSchema = z.object({
	name: z.string(),
	bootname: z.string().nullable(),
	state: z.string(),
	bootStatus: z.string().nullable(),
	version: z.string().nullable(),
	lastSyncedAt: z.string().nullable(),
});
export type UpdateSlotStatus = z.infer<typeof updateSlotStatusSchema>;

/** The orchestrator's per-kind schedule clock, epoch milliseconds. */
export const updateCheckClockSummarySchema = z.object({
	lastAttemptAt: z.number().nullable(),
	lastSuccessAt: z.number().nullable(),
	nextAttemptAt: z.number().nullable(),
});
export type UpdateCheckClockSummary = z.infer<typeof updateCheckClockSummarySchema>;

/** Mirrors the update-transport selector's probe verdicts (`update-transport/core.ts`). */
export const updateTransportProbeStateSchema = z.enum([
	'clear',
	'captive-http',
	'captive-tls',
	'tls-error',
	'tampered',
	'blocked',
	'no-route',
	'dns-failed',
	'credentials-invalid',
	'probe-unavailable',
]);
export type UpdateTransportProbeState = z.infer<typeof updateTransportProbeStateSchema>;

export const updateTransportUplinkKindSchema = z.enum([
	'ethernet',
	'wifi',
	'dongle',
	'cellular',
	'other',
]);
export type UpdateTransportUplinkKind = z.infer<typeof updateTransportUplinkKindSchema>;

export const updateTransportFamilySchema = z.union([z.literal(4), z.literal(6)]);

/** One ranked candidate (uplink × address family) the last selection probed. */
export const updateTransportFindingSchema = z.object({
	ifname: z.string(),
	kind: updateTransportUplinkKindSchema,
	family: updateTransportFamilySchema,
	metered: z.boolean(),
	healthy: z.boolean(),
	captive: z.boolean(),
	/** Every non-`clear` verdict any host returned on this candidate, de-duplicated. */
	states: z.array(updateTransportProbeStateSchema),
});
export type UpdateTransportFinding = z.infer<typeof updateTransportFindingSchema>;

/** The most recent update-transport selection — an observation, never a route input. */
export const updateTransportSummarySchema = z.object({
	profile: z.enum(['apt', 'os']),
	checkedAt: z.number(),
	status: z.enum(['selected', 'none']),
	selected: z
		.object({
			ifname: z.string(),
			kind: updateTransportUplinkKindSchema,
			family: updateTransportFamilySchema,
			metered: z.boolean(),
		})
		.nullable(),
	findings: z.array(updateTransportFindingSchema),
});
export type UpdateTransportSummary = z.infer<typeof updateTransportSummarySchema>;

export const updateDetailsSchema = z.object({
	/** `null` unless the image declares `slot-sync` AND `rauc status` answered. */
	slots: z.array(updateSlotStatusSchema).nullable(),
	os: z.object({
		/** The release-cut CalVer stamp; `null` on every image that lacks one. */
		bootedVersion: z.string().nullable(),
		/** Present only while a staged image is waiting to be activated/verified. */
		staged: z.object({ version: z.string(), stagedAt: z.number() }).nullable(),
		/** The verified manifest the last channel check found, not yet staged. */
		candidate: z.object({ version: z.string(), sizeBytes: z.number() }).nullable(),
	}),
	checks: z.object({
		packages: updateCheckClockSummarySchema,
		os: updateCheckClockSummarySchema,
	}),
	/** An OS download held behind the metered-only gate for one-time approval. */
	pendingCellular: z.object({ id: z.string(), sizeBytes: z.number() }).nullable(),
	transport: updateTransportSummarySchema.nullable(),
});
export type UpdateDetails = z.infer<typeof updateDetailsSchema>;

/** `system.allowCellularOnce` — grants exactly one pending OS download, by candidate id. */
export const allowCellularOnceInputSchema = z.object({ id: z.string().min(1) });
export type AllowCellularOnceInput = z.infer<typeof allowCellularOnceInputSchema>;
