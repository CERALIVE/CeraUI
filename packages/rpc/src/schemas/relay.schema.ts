/**
 * Relay Zod schemas
 */
import { z } from 'zod';

// Relay account schema
export const relayAccountSchema = z.object({
	name: z.string(),
});
export type RelayAccount = z.infer<typeof relayAccountSchema>;

// Relay server schema
export const relayServerSchema = z.object({
	name: z.string(),
});
export type RelayServer = z.infer<typeof relayServerSchema>;

// Relay message schema
export const relayMessageSchema = z.object({
	accounts: z.record(z.string(), relayAccountSchema),
	servers: z.record(z.string(), relayServerSchema),
});
export type RelayMessage = z.infer<typeof relayMessageSchema>;
