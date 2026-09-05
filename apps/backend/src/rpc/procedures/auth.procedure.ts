/**
 * Authentication Procedures
 * Wraps existing auth logic from modules/ui/auth.ts
 */

import {
	loginInputSchema,
	loginOutputSchema,
	logoutOutputSchema,
	revokeTokenInputSchema,
	revokeTokenOutputSchema,
	setPasswordInputSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import {
	loadCacheFile,
	writeFileAtomicSync,
} from "../../helpers/config-loader.ts";
import {
	type AuthTokens,
	authTokensSchema,
} from "../../helpers/config-schemas.ts";
import { randomBase64 } from "../../helpers/crypto.ts";
import { logger } from "../../helpers/logger.ts";
import { getPasswordHash, setPasswordHash } from "../state/password.ts";
import type { RPCContext } from "../types.ts";

const AUTH_TOKENS_FILE = "auth_tokens.json";
const BCRYPT_ROUNDS = 10;

const TOKEN_RECORD_RE = /^[0-9a-f]{64}$/;

// Token storage
const tempTokens: Record<string, true> = {};
const persistentTokens: AuthTokens = await loadCacheFile(
	AUTH_TOKENS_FILE,
	authTokensSchema,
);

// Re-export for backward compatibility
export { getPasswordHash, setPasswordHash };

// `auth_tokens.json` used to hold tokens VERBATIM, so reading the file handed
// you a working credential for every remembered browser. A digest makes it a
// lookup table instead: a leak proves which credentials exist, not what they
// are. SHA-256 rather than a KDF because the token is 32 CSPRNG bytes — there
// is no guessable structure for a slow hash to defend, and every reconnect
// pays this.
function tokenRecord(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function savePersistentTokens() {
	writeFileAtomicSync(AUTH_TOKENS_FILE, JSON.stringify(persistentTokens));
}

// A pre-migration file holds raw tokens. They are already inert — lookup is
// keyed on the digest, which a base64 token cannot match — but leaving them
// keeps credential material on disk and makes "log out everywhere" count
// entries nothing can use.
function pruneLegacyTokenRecords(): void {
	let pruned = 0;
	for (const key of Object.keys(persistentTokens)) {
		if (TOKEN_RECORD_RE.test(key)) continue;
		delete persistentTokens[key];
		pruned += 1;
	}
	if (pruned === 0) return;
	savePersistentTokens();
	logger.info(
		`Auth: pruned ${pruned} pre-digest persistent token record(s); affected browsers re-authenticate with the password once`,
	);
}

pruneLegacyTokenRecords();

function genAuthToken(isPersistent: boolean): string {
	const token = randomBase64(32);
	if (isPersistent) {
		persistentTokens[tokenRecord(token)] = true;
		savePersistentTokens();
	} else {
		tempTokens[token] = true;
	}
	return token;
}

function knownToken(token: string): boolean {
	return (
		tempTokens[token] === true || persistentTokens[tokenRecord(token)] === true
	);
}

function invalidateToken(token: string): number {
	let revoked = 0;
	if (tempTokens[token]) {
		delete tempTokens[token];
		revoked += 1;
	}
	const record = tokenRecord(token);
	if (persistentTokens[record]) {
		delete persistentTokens[record];
		savePersistentTokens();
		revoked += 1;
	}
	return revoked;
}

function invalidateAllTokens(): number {
	let revoked = 0;
	for (const token of Object.keys(tempTokens)) {
		delete tempTokens[token];
		revoked += 1;
	}
	const records = Object.keys(persistentTokens);
	for (const record of records) {
		delete persistentTokens[record];
		revoked += 1;
	}
	if (records.length > 0) savePersistentTokens();
	return revoked;
}

/**
 * Mint a non-persistent session token for the single-use loopback kiosk
 * exchange (DC-3). Same in-memory temp-token store as a password login, so the
 * kiosk browser can authenticate the WebSocket with it. Not persisted to disk;
 * unrelated to the PASETO device token.
 */
export function issueKioskSessionToken(): string {
	return genAuthToken(false);
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
			if (knownToken(input.token)) {
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
			config.password = undefined;
			saveConfig();

			// A credential issued against the OLD password must not outlive it —
			// otherwise changing the password after losing a device leaves that
			// device signed in. The calling socket is re-authenticated on a fresh
			// token so the operator who just changed it is not thrown out.
			const revoked = invalidateAllTokens();
			const replacement = genAuthToken(false);
			context.authenticate(replacement);
			logger.info(
				`Auth: password updated; revoked ${revoked} outstanding credential(s)`,
			);
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

// Gated here rather than by `authedProcedure`: every procedure in this file
// takes the raw context, because setPassword must also serve first-run setup.
export const revokeTokenProcedure = baseProcedure
	.input(revokeTokenInputSchema)
	.output(revokeTokenOutputSchema)
	.handler(({ input, context }) => {
		if (!context.isAuthenticated()) {
			logger.warn("Auth: revokeToken refused — socket is not authenticated");
			return { success: false, revoked: 0 };
		}

		if (input.scope === "all") {
			const revoked = invalidateAllTokens();
			context.deauthenticate();
			logger.info(`Auth: revoked all ${revoked} credential(s)`);
			return { success: true, revoked };
		}

		const target = input.token ?? context.ws.data.authToken;
		if (target === undefined) {
			return { success: true, revoked: 0 };
		}

		const revoked = invalidateToken(target);
		// Only a socket revoking its OWN credential loses its session; retiring
		// some other browser's token must not sign the caller out.
		if (target === context.ws.data.authToken) {
			context.deauthenticate();
		}
		logger.info(`Auth: revoked ${revoked} credential record(s)`);
		return { success: true, revoked };
	});
