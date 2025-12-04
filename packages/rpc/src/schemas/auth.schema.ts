/**
 * Authentication Zod schemas
 */
import { z } from 'zod';

// Login input schema
export const loginInputSchema = z.object({
	password: z.string().optional(),
	token: z.string().optional(),
	persistent_token: z.boolean().default(false),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

// Login output schema
export const loginOutputSchema = z.object({
	success: z.boolean(),
	auth_token: z.string().optional(),
});
export type LoginOutput = z.infer<typeof loginOutputSchema>;

// Alias for backward compatibility
export type AuthMessage = LoginOutput;

// Set password input schema
export const setPasswordInputSchema = z.object({
	password: z.string().min(8, 'Minimum password length: 8 characters'),
});
export type SetPasswordInput = z.infer<typeof setPasswordInputSchema>;

// Logout output schema
export const logoutOutputSchema = z.object({
	success: z.boolean(),
});
export type LogoutOutput = z.infer<typeof logoutOutputSchema>;
