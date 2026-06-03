/**
 * Broadcast envelope Zod schemas
 * Defines the structure for broadcast messages with optional sequencing and ACK seam
 */
import { z } from 'zod';

// ACK object schema (future: per-message acknowledgment)
export const ackSchema = z.object({
	id: z.string(),
});
export type Ack = z.infer<typeof ackSchema>;

// Broadcast envelope schema
// Wraps any broadcast message with optional seq (for ordering/deduplication)
// and optional ack (future: per-message ACK, Ambition B)
export const broadcastEnvelopeSchema = z.object({
	type: z.string(),
	data: z.unknown(),
	// @future: not wired — per-type seq counter (Task 7 adds producer-side counter)
	seq: z.number().optional(),
	// @future: not wired — per-message ACK (Ambition B), do not implement
	ack: ackSchema.optional(),
});
export type BroadcastEnvelope = z.infer<typeof broadcastEnvelopeSchema>;
