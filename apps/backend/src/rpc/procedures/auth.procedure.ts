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
import type { AuthTokens } from "../../helpers/config-schemas.ts";
import { randomBase64 } from "../../helpers/crypto.ts";
import { logger } from "../../helpers/logger.ts";
import { isDevelopment } from "../../mocks/mock-config.ts";
import { getPasswordHash, setPasswordHash } from "../state/password.ts";
import { PersistentTokenStore } from "../state/persistent-token-store.ts";
import type { RPCContext } from "../types.ts";

const AUTH_TOKENS_FILE = "auth_tokens.json";
const BCRYPT_ROUNDS = 10;

const TOKEN_RECORD_RE = /^[0-9a-f]{64}$/;

// Token storage
const tempTokens: Record<string, true> = {};
const tokenStore = await PersistentTokenStore.open(AUTH_TOKENS_FILE);
const persistentTokens: AuthTokens = tokenStore.records;

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

// Every write is revalidated against the file, so it also drops any inert
// pre-digest record that reread brought back.
function savePersistentTokens() {
	for (const key of Object.keys(persistentTokens))
		if (!TOKEN_RECORD_RE.test(key)) delete persistentTokens[key];
	tokenStore.save();
}

// A pre-migration file holds raw tokens. They are already inert — lookup is
// keyed on the digest, which a base64 token cannot match — but leaving them
// keeps credential material on disk and makes "log out everywhere" count
// entries nothing can use. Returns false while the migration is still owed.
function pruneLegacyTokenRecords(): boolean {
	if (!tokenStore.prepareWrite()) return false;
	const legacy = Object.keys(persistentTokens).filter(
		(key) => !TOKEN_RECORD_RE.test(key),
	);
	if (legacy.length === 0) return true;
	for (const key of legacy) delete persistentTokens[key];
	savePersistentTokens();
	logger.info(
		`Auth: pruned ${legacy.length} pre-digest persistent token record(s); affected browsers re-authenticate with the password once`,
	);
	return true;
}

// The prune runs off a timer, so a write fault (EIO, ENOSPC) must not escape it
// and kill the backend; the file is left as it was and the prune is retried.
const LEGACY_PRUNE_RETRY_MS = [1000, 5000, 30_000, 60_000] as const;
let legacyPruneTimer: ReturnType<typeof setTimeout> | undefined;
let legacyPruneStopped = false;

function scheduleLegacyPrune(delay: number, attempt: number): void {
	if (legacyPruneStopped) return;
	legacyPruneTimer = setTimeout(() => {
		legacyPruneTimer = undefined;
		let done = false;
		try {
			done = pruneLegacyTokenRecords();
		} catch (error) {
			logger.warn("Auth: pre-digest token prune failed; retrying", { error });
		}
		const wait =
			LEGACY_PRUNE_RETRY_MS[
				Math.min(attempt, LEGACY_PRUNE_RETRY_MS.length - 1)
			];
		if (!done && wait !== undefined) scheduleLegacyPrune(wait, attempt + 1);
	}, delay);
	legacyPruneTimer.unref();
}

/** Shutdown: no further prune attempt may start. */
export function stopLegacyTokenMigration(): void {
	legacyPruneStopped = true;
	clearTimeout(legacyPruneTimer);
	legacyPruneTimer = undefined;
}

if (!isDevelopment()) scheduleLegacyPrune(0, 0);

function genAuthToken(isPersistent: boolean): string {
	const token = randomBase64(32);
	// A store that could not be read yields a session that lasts this browser
	// visit; persisting would replace remembered memberships nobody has read. A
	// failed write does the same instead of failing the password login.
	if (isPersistent && tokenStore.prepareWrite()) {
		const record = tokenRecord(token);
		persistentTokens[record] = true;
		try {
			savePersistentTokens();
			return token;
		} catch (error) {
			delete persistentTokens[record];
			logger.warn(
				"Auth: remembered login not persisted; session is temporary",
				{
					error,
				},
			);
		}
	}
	tempTokens[token] = true;
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
	// Revalidated against the file: the write starts from what it now holds.
	if (tokenStore.prepareWrite() && persistentTokens[record]) {
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
	// Revoking everything does not depend on what the file held, so an
	// unreadable store is still emptied (a damaged one is archived first): a
	// password change must not leave old remembered browsers to come back once
	// storage recovers.
	if (tokenStore.prepareWrite(true) || tokenStore.unavailable) {
		for (const record of Object.keys(persistentTokens))
			delete persistentTokens[record];
		savePersistentTokens();
	}
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
		await tokenStore.settle();
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
		await tokenStore.settle();
		const isAuthed = context.isAuthenticated();
		const currentHash = getPasswordHash();

		// Allow setting password if authenticated or if no password is set yet
		if (isAuthed || !currentHash) {
			// Lazy import to avoid circular dependency. Read config FIRST: while it
			// is unavailable this throws before the in-memory hash changes, so an
			// unknown stored password can never be replaced by a first-run claim.
			const { getConfig, saveConfig } = await import("../../modules/config.ts");
			const config = getConfig();
			const newHash = Bun.password.hashSync(input.password, {
				algorithm: "bcrypt",
				cost: BCRYPT_ROUNDS,
			});
			setPasswordHash(newHash);
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
	.handler(async ({ context }) => {
		await tokenStore.settle();
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
	.handler(async ({ input, context }) => {
		await tokenStore.settle();
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
