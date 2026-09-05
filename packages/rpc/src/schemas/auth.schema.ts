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

// An explicit scope rather than a boolean flag: "revoke this credential" and
// "log out everywhere" differ only in blast radius, so a caller must name which.
export const tokenRevokeScopeSchema = z.enum(['token', 'all']);
export type TokenRevokeScope = z.infer<typeof tokenRevokeScopeSchema>;

// `.strict()` because this arms a credential-destroying action: an unknown key
// must be REJECTED, not ignored — the rule every mutation input here follows.
export const revokeTokenInputSchema = z
	.object({
		// Absent ⇒ the calling socket's own token.
		token: z.string().min(1).optional(),
		scope: tokenRevokeScopeSchema.default('token'),
	})
	.strict();
export type RevokeTokenInput = z.infer<typeof revokeTokenInputSchema>;

// A COUNT, never a boolean: revoking an already-gone credential succeeds with
// `revoked: 0`, which a consumer must be able to tell from a real revocation.
export const revokeTokenOutputSchema = z.object({
	success: z.boolean(),
	revoked: z.number().int().min(0),
});
export type RevokeTokenOutput = z.infer<typeof revokeTokenOutputSchema>;
