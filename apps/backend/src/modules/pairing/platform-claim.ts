/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Real platform claim (device-pairing-claim-code change, Task 22).
 *
 * The production counterpart to {@link ./mock-platform.ts}: instead of issuing a
 * token locally, this submits the device's claim-code + serial to the cloud
 * platform's `POST /api/claim` endpoint (ceralive-platform `apps/api`). On a 200
 * the platform returns an opaque device token bound to the caller's tenant; that
 * token is handed to `applyToken`, which stores it as the active `remote_key`
 * (the channel then presents it on every reconnect — opaque-token path, ADR-0006
 * PASETO still deferred).
 *
 * The platform base URL is read from the `PLATFORM_URL` env var — never
 * hardcoded. All HTTP failure modes the platform route documents
 * (ceralive-platform `apps/api/routes/claim.ts`) are mapped onto stable machine
 * error codes the UI can branch on:
 *   - 400 → invalid-claim-code (malformed / forged code)
 *   - 402 → subscription-required (billing gate)
 *   - 409 → claim-code-consumed (replay guard)
 *   - 410 → claim-code-expired (aged-out code)
 * plus network/timeout (`network-error`), an unset URL (`platform-not-configured`),
 * and an unparseable body (`invalid-platform-response`).
 */

import type { CompletePairingOutput } from "@ceraui/rpc/schemas";
import { z } from "zod";

import { logger } from "../../helpers/logger.ts";
import { isRealDevice } from "../system/device-detection.ts";
import { getDeviceSerial, getPairingSecret } from "./claim-code.ts";

/** Abort the claim request after this long; surfaces as `network-error`. */
export const PLATFORM_CLAIM_TIMEOUT_MS = 10_000;

/** Abort a pairing-secret registration request after this long. */
export const PAIRING_SECRET_REGISTER_TIMEOUT_MS = 10_000;

/** Total attempts for pairing-secret registration before giving up (1 + retries). */
export const PAIRING_SECRET_REGISTER_MAX_ATTEMPTS = 3;

/** Backoff between pairing-secret registration retries. */
export const PAIRING_SECRET_REGISTER_RETRY_DELAY_MS = 500;

/** Platform route that records a device's pairing secret (task 6). */
export const PAIRING_SECRET_REGISTER_PATH = "/api/device/pairing-secret";

/**
 * Cloud platform base URL, sourced from the `PLATFORM_URL` env var (never
 * hardcoded). Returns `undefined` when unset/blank so the caller surfaces an
 * explicit "not configured" error rather than issuing a request to nowhere.
 */
export function getPlatformUrl(): string | undefined {
	return process.env.PLATFORM_URL?.trim() || undefined;
}

/**
 * Shape of a successful `POST /api/claim` response (ceralive-platform
 * `lib/claim.ts` `ClaimResponse`). The platform repo is cross-repo and not a
 * build dependency, so the contract is mirrored here rather than imported.
 */
const platformClaimResponseSchema = z.object({
	deviceToken: z.string().min(1),
	tokenType: z.string(),
	deviceId: z.string(),
	tenantId: z.string(),
	serial: z.string(),
	claimedAt: z.string(),
});

/**
 * Map a platform claim HTTP error status onto a stable machine code. Mirrors the
 * platform route's status contract (ceralive-platform `routes/claim.ts`).
 */
export function platformClaimErrorForStatus(status: number): string {
	switch (status) {
		case 400:
			return "invalid-claim-code";
		case 402:
			return "subscription-required";
		case 409:
			return "claim-code-consumed";
		case 410:
			return "claim-code-expired";
		default:
			return `platform-error-${status}`;
	}
}

export type PairingSecretRegisterResult = {
	registered: boolean;
	skipped?: boolean;
	error?: string;
};

export interface RegisterPairingSecretDeps {
	/** Override the device serial (defaults to the live device serial). */
	serial?: string;
	/** Override the on-device pairing secret (defaults to the live device secret). */
	secret?: string;
	/** Injected fetch (defaults to global `fetch`) — testable without a network. */
	fetchImpl?: typeof fetch;
	/** Real-device gate (defaults to {@link isRealDevice}). */
	isRealDeviceImpl?: () => Promise<boolean>;
	/** Retry backoff sleep (defaults to a real timer) — injectable so tests don't wait. */
	delayImpl?: (ms: number) => Promise<void>;
}

/**
 * Register this device's on-device pairing secret with the platform so the
 * platform can verify the device's claim-code (task 6/7 — `POST
 * /api/device/pairing-secret`, body `{ serial, pairingSecret }`).
 *
 * Gated on {@link isRealDevice}: a no-op (`skipped`) in dev/mock mode. The
 * secret is only READ from its existing store ({@link getPairingSecret}) — never
 * persisted anywhere new on-device. A transient HTTP/network failure is retried
 * up to {@link PAIRING_SECRET_REGISTER_MAX_ATTEMPTS} times then logged; this
 * function NEVER throws, so a registration failure can never crash the pairing
 * flow.
 */
export async function registerPairingSecret(
	deps: RegisterPairingSecretDeps = {},
): Promise<PairingSecretRegisterResult> {
	const isReal = deps.isRealDeviceImpl ?? isRealDevice;
	if (!(await isReal())) {
		return { registered: false, skipped: true };
	}

	const platformUrl = getPlatformUrl();
	if (!platformUrl) {
		logger.error(
			"pairing: PLATFORM_URL is not configured; skipping pairing-secret registration",
		);
		return { registered: false, error: "platform-not-configured" };
	}

	let endpoint: URL;
	try {
		endpoint = new URL(PAIRING_SECRET_REGISTER_PATH, platformUrl);
	} catch {
		logger.error(`pairing: invalid PLATFORM_URL "${platformUrl}"`);
		return { registered: false, error: "platform-not-configured" };
	}

	const serial = deps.serial ?? (await getDeviceSerial());
	const pairingSecret = deps.secret ?? getPairingSecret();
	const fetchImpl = deps.fetchImpl ?? fetch;
	const delay =
		deps.delayImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

	let lastError = "network-error";
	for (
		let attempt = 1;
		attempt <= PAIRING_SECRET_REGISTER_MAX_ATTEMPTS;
		attempt++
	) {
		try {
			const response = await fetchImpl(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ serial, pairingSecret }),
				signal: AbortSignal.timeout(PAIRING_SECRET_REGISTER_TIMEOUT_MS),
			});
			if (response.ok) {
				logger.info("pairing: registered device pairing secret with platform");
				return { registered: true };
			}
			lastError = `platform-error-${response.status}`;
			logger.warn(
				`pairing: pairing-secret registration rejected (status=${response.status}, attempt=${attempt}/${PAIRING_SECRET_REGISTER_MAX_ATTEMPTS})`,
			);
		} catch (err) {
			lastError = "network-error";
			const message = err instanceof Error ? err.message : String(err);
			logger.warn(
				`pairing: pairing-secret registration request failed (attempt=${attempt}/${PAIRING_SECRET_REGISTER_MAX_ATTEMPTS}): ${message}`,
			);
		}

		if (attempt < PAIRING_SECRET_REGISTER_MAX_ATTEMPTS) {
			await delay(PAIRING_SECRET_REGISTER_RETRY_DELAY_MS);
		}
	}

	logger.error(
		`pairing: pairing-secret registration failed after ${PAIRING_SECRET_REGISTER_MAX_ATTEMPTS} attempts (error=${lastError})`,
	);
	return { registered: false, error: lastError };
}

export interface CompletePlatformPairingDeps {
	/** Persist the issued token as the active remote key and reconnect the channel. */
	applyToken: (token: string) => Promise<void> | void;
	/** Override the device serial (defaults to the live device serial). */
	serial?: string;
	/** Injected fetch (defaults to global `fetch`) — testable without a network. */
	fetchImpl?: typeof fetch;
	/** Register the pairing secret with the platform (injectable for tests). */
	registerSecret?: (
		deps: RegisterPairingSecretDeps,
	) => Promise<PairingSecretRegisterResult>;
}

/**
 * Complete pairing against the REAL platform: POST `{ claimCode, serial }` to
 * `<PLATFORM_URL>/api/claim`, and on a 200 persist the returned opaque device
 * token via `applyToken`. The token is opaque (PASETO deferred — ADR-0006), so
 * it carries no readable claims: only `device_id` is surfaced; `sub_status` and
 * `validUntil` are unavailable on this path. Any non-200 / network / parse
 * failure resolves to `{ paired: false, error }` WITHOUT applying a token.
 */
export async function completePlatformPairing(
	code: string,
	deps: CompletePlatformPairingDeps,
): Promise<CompletePairingOutput> {
	const platformUrl = getPlatformUrl();
	if (!platformUrl) {
		logger.error("pairing: PLATFORM_URL is not configured");
		return { paired: false, error: "platform-not-configured" };
	}

	let endpoint: URL;
	try {
		endpoint = new URL("/api/claim", platformUrl);
	} catch {
		logger.error(`pairing: invalid PLATFORM_URL "${platformUrl}"`);
		return { paired: false, error: "platform-not-configured" };
	}

	const serial = deps.serial ?? (await getDeviceSerial());
	const fetchImpl = deps.fetchImpl ?? fetch;
	const registerSecret = deps.registerSecret ?? registerPairingSecret;

	await registerSecret({ serial, fetchImpl });

	let response: Response;
	try {
		response = await fetchImpl(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claimCode: code, serial }),
			signal: AbortSignal.timeout(PLATFORM_CLAIM_TIMEOUT_MS),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`pairing: platform claim request failed: ${message}`);
		return { paired: false, error: "network-error" };
	}

	if (!response.ok) {
		const error = platformClaimErrorForStatus(response.status);
		logger.warn(
			`pairing: platform claim rejected (status=${response.status}, error=${error})`,
		);
		return { paired: false, error };
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		logger.error("pairing: platform claim returned a non-JSON body");
		return { paired: false, error: "invalid-platform-response" };
	}

	const parsed = platformClaimResponseSchema.safeParse(body);
	if (!parsed.success) {
		logger.error("pairing: platform claim response failed validation");
		return { paired: false, error: "invalid-platform-response" };
	}

	await deps.applyToken(parsed.data.deviceToken);

	return { paired: true, device_id: parsed.data.deviceId };
}
