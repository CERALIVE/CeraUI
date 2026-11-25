import { z } from 'zod';

export const radioMetricSchema = z.object({
	value: z.union([z.number(), z.string()]).nullable(),
	source: z.string(),
	unit: z.string(),
	technology: z.string(),
	capturedAt: z.number(),
	reason: z
		.enum(['not-reported', 'not-observed', 'stale', 'unsupported', 'not-available'])
		.optional(),
});
export type RadioMetric = z.infer<typeof radioMetricSchema>;
export const radioFindingSchema = z.object({
	kind: z.enum(['unknown', 'sim-account', 'data-path', 'disturbed']),
	confidence: z.enum(['unknown', 'possible', 'likely']),
	neighbour: z.string().optional(),
	evidence: z.array(z.string()).max(16),
});
export type RadioFinding = z.infer<typeof radioFindingSchema>;
export const radioHealthSchema = z.object({
	capturedAt: z.number(),
	registration: radioMetricSchema,
	layer: radioMetricSchema,
	band: radioMetricSchema,
	metrics: z.record(z.string(), radioMetricSchema),
	neighbours: z.array(
		z.object({
			id: z.string(),
			band: radioMetricSchema,
			transmitting: z.enum(['yes', 'unknown']),
			source: z.string(),
			capturedAt: z.number(),
		}),
	),
	usb: z.object({
		available: z.boolean(),
		events: z.array(z.object({ at: z.number(), kind: z.enum(['reset', 'disconnect']) })).max(128),
	}),
	finding: radioFindingSchema,
	timeline: z
		.array(
			z.object({
				at: z.number(),
				finding: radioFindingSchema,
				observation: z
					.object({
						band: radioMetricSchema,
						rsrp: radioMetricSchema,
						quality: radioMetricSchema,
						usbEvents: z.number().int().nonnegative(),
						neighbours: z.array(
							z.object({
								id: z.string(),
								band: radioMetricSchema,
								transmitting: z.enum(['yes', 'unknown']),
							}),
						),
					})
					.optional(),
			}),
		)
		.max(120),
});
export type RadioHealth = z.infer<typeof radioHealthSchema>;
export const radioHealthListSchema = z.record(z.string(), radioHealthSchema);
