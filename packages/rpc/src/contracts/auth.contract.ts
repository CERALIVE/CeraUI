/**
 * Authentication ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	loginInputSchema,
	loginOutputSchema,
	logoutOutputSchema,
	revokeTokenInputSchema,
	revokeTokenOutputSchema,
	setPasswordInputSchema,
	successResponseSchema,
} from '../schemas';

export const authContract = oc.router({
	/**
	 * Login with password or token
	 */
	login: oc.input(loginInputSchema).output(loginOutputSchema),

	/**
	 * Set or change password
	 */
	setPassword: oc.input(setPasswordInputSchema).output(successResponseSchema),

	/**
	 * Logout and invalidate token
	 */
	logout: oc.output(logoutOutputSchema),

	/**
	 * Revoke a persistent credential, or every one of them
	 */
	revokeToken: oc.input(revokeTokenInputSchema).output(revokeTokenOutputSchema),
});
