/**
 * Authentication Procedures
 * Wraps existing auth logic from modules/ui/auth.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import {
	loginInputSchema,
	loginOutputSchema,
	logoutOutputSchema,
	setPasswordInputSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { loadCacheFile } from "../../helpers/config-loader.ts";
import {
	type AuthTokens,
	authTokensSchema,
} from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { getPasswordHash, setPasswordHash } from "../state/password.ts";
import type { RPCContext } from "../types.ts";

const AUTH_TOKENS_FILE = "auth_tokens.json";
const BCRYPT_ROUNDS = 10;

// Token storage
const tempTokens: Record<string, true> = {};
const persistentTokens: AuthTokens = loadCacheFile(
	AUTH_TOKENS_FILE,
	authTokensSchema,
);

// Re-export for backward compatibility
export { getPasswordHash, setPasswordHash };

function savePersistentTokens() {
	fs.writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(persistentTokens));
}

function genAuthToken(isPersistent: boolean): string {
	const token = crypto.randomBytes(32).toString("base64");
	if (isPersistent) {
		persistentTokens[token] = true;
		savePersistentTokens();
	} else {
		tempTokens[token] = true;
	}
	return token;
}

function invalidateToken(token: string) {
	delete tempTokens[token];
	if (persistentTokens[token]) {
		delete persistentTokens[token];
		savePersistentTokens();
	}
}

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

/**
 * Login procedure
 */
export const loginProcedure = baseProcedure
	.input(loginInputSchema)
	.output(loginOutputSchema)
	.handler(async ({ input, context }) => {
		const passwordHash = getPasswordHash();
		logger.debug(
			`Login attempt: passwordHash=${passwordHash ? "set" : "not set"}, input.password=${input.password ? "provided" : "none"}, input.token=${input.token ? "provided" : "none"}`,
		);
		if (!passwordHash) {
			logger.debug("Login failed: no password hash set");
			return { success: false };
		}

		// Password authentication
		if (input.password) {
			try {
				const match = await Bun.password.verify(
					input.password,
					passwordHash,
					"bcrypt",
				);
				if (match) {
					const token = genAuthToken(input.persistent_token);
					context.authenticate(token);
					logger.info("Auth: password login successful");
					return { success: true, auth_token: token };
				}
			} catch (_e) {
				// Password verification failed
			}
			logger.warn("Auth: invalid password");
			return { success: false };
		}

		// Token authentication
		if (input.token) {
			if (tempTokens[input.token] || persistentTokens[input.token]) {
				context.authenticate(input.token);
				logger.info("Auth: token login successful");
				return { success: true };
			}
			logger.warn("Auth: invalid token");
			return { success: false };
		}

		return { success: false };
	});

/**
 * Set password procedure
 */
export const setPasswordProcedure = baseProcedure
	.input(setPasswordInputSchema)
	.output(successResponseSchema)
	.handler(async ({ input, context }) => {
		const isAuthed = context.isAuthenticated();
		const currentHash = getPasswordHash();

		// Allow setting password if authenticated or if no password is set yet
		if (isAuthed || !currentHash) {
			const newHash = Bun.password.hashSync(input.password, {
				algorithm: "bcrypt",
				cost: BCRYPT_ROUNDS,
			});
			setPasswordHash(newHash);

			// Lazy import to avoid circular dependency
			const { getConfig, saveConfig } = await import("../../modules/config.ts");
			const config = getConfig();
			// @ts-expect-error - password field exists on config type
			config.password = undefined;
			saveConfig();
			logger.info("Auth: password updated");
			return { success: true };
		}

		return { success: false };
	});

/**
 * Logout procedure
 */
export const logoutProcedure = baseProcedure
	.output(logoutOutputSchema)
	.handler(({ context }) => {
		const token = context.ws.data.authToken;
		if (token) {
			invalidateToken(token);
		}
		context.deauthenticate();
		logger.info("Auth: logout successful");
		return { success: true };
	});
