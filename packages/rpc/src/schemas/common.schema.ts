/**
 * Common Zod schemas shared across multiple domains
 */
import { z } from 'zod';

// Notification types
export const notificationTypeSchema = z.enum(['success', 'warning', 'error', 'info']);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

// Generic nullable helper
export const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable();

// Success response schema (common pattern)
export const successResponseSchema = z.object({
	success: z.boolean(),
});
export type SuccessResponse = z.infer<typeof successResponseSchema>;

// Error response schema
export const errorResponseSchema = z.object({
	success: z.literal(false),
	error: z.string(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
