/**
 * Heartbeat ping/pong schema for server→client liveness detection
 *
 * Server sends periodic pings with a timestamp to prove liveness.
 * Client responds with pong to acknowledge receipt.
 *
 * Design:
 * - Server→client only (client keepalive already exists at client.ts:187-191)
 * - Default threshold ~15s (≈3 missed 5s pings)
 * - Prefer WS protocol-level ping/pong if Bun adapter exposes it
 */
import { z } from 'zod';

/**
 * Ping message: server→client with timestamp
 * { t: number } — monotonic/timestamp in milliseconds
 */
export const pingSchema = z.object({
	t: z.number().int().positive().describe('Timestamp in milliseconds'),
});
export type Ping = z.infer<typeof pingSchema>;

/**
 * Pong message: client→server acknowledgment
 * Simple boolean flag to confirm receipt
 */
export const pongSchema = z.object({
	pong: z.literal(true).describe('Pong acknowledgment'),
});
export type Pong = z.infer<typeof pongSchema>;
