/**
 * Network interface Zod schemas
 */
import { z } from 'zod';

// Network interface entry schema
export const netifEntrySchema = z.object({
	ip: z.string().optional(),
	tp: z.number(),
	enabled: z.boolean(),
	error: z.string().optional(),
});
export type NetifEntry = z.infer<typeof netifEntrySchema>;

// Network interfaces message schema
export const netifMessageSchema = z.record(z.string(), netifEntrySchema);
export type NetifMessage = z.infer<typeof netifMessageSchema>;

// Network interface config input schema
export const netifConfigInputSchema = z.object({
	name: z.string(),
	ip: z.string().optional(),
	enabled: z.boolean(),
});
export type NetifConfigInput = z.infer<typeof netifConfigInputSchema>;

// Network interface config output schema
export const netifConfigOutputSchema = z.object({
	success: z.boolean(),
});
export type NetifConfigOutput = z.infer<typeof netifConfigOutputSchema>;
