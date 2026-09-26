import { z } from 'zod';

export const updateCapabilityFeatureSchema = z.enum([
	'rauc-verity-streaming',
	'rauc-activate-on-shutdown',
	'slot-sync',
	'origin-protection',
	'apt-all-packages',
	'reprune-hook',
	'apt-credentials',
	'transport-uidrange',
]);

export const updateCapabilityFileSchema = z
	.object({
		schema: z.literal(1),
		features: z.array(updateCapabilityFeatureSchema),
		ota_uid: z.number().int().nonnegative(),
		apt_uid: z.number().int().nonnegative(),
	})
	.strict();

export const updateCapabilitiesSchema = z
	.object({
		mode: z.enum(['legacy', 'capable']),
		features: z.array(updateCapabilityFeatureSchema),
	})
	.strict();

export type UpdateCapabilities = z.infer<typeof updateCapabilitiesSchema>;
