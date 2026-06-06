/**
 * Device-pairing controller (device-pairing-claim-code, Task 25).
 *
 * Drives the device-side claim-code pairing surface: request a fresh code, run
 * the validity-window countdown, and (in mock mode) complete pairing against the
 * mock platform so the issued token is stored as the active remote key. Built as
 * a runes class so each dialog instance owns its own state and ticker.
 */
import type { CompletePairingOutput, SubscriptionStatus } from '@ceraui/rpc/schemas';

import { rpc } from '$lib/rpc/client';

import {
	claimCodeRemainingMs,
	formatClaimCodeRemaining,
	isClaimCodeExpired,
} from './claim-code-format';

export type PairingStatus =
	| 'idle'
	| 'generating'
	| 'active'
	| 'pairing'
	| 'paired'
	| 'error';

const COUNTDOWN_INTERVAL_MS = 1000;

export class PairingController {
	code = $state<string | null>(null);
	validUntil = $state(0);
	windowSeconds = $state(0);
	status = $state<PairingStatus>('idle');
	error = $state<string | null>(null);
	deviceId = $state<string | null>(null);
	subStatus = $state<SubscriptionStatus | null>(null);
	now = $state(Date.now());

	#ticker: ReturnType<typeof setInterval> | null = null;

	remainingMs = $derived(claimCodeRemainingMs(this.validUntil, this.now));
	remainingLabel = $derived(formatClaimCodeRemaining(this.remainingMs));
	expired = $derived(this.code !== null && isClaimCodeExpired(this.validUntil, this.now));

	async generate(): Promise<void> {
		this.status = 'generating';
		this.error = null;
		try {
			const result = await rpc.pairing.generateClaimCode();
			this.code = result.code;
			this.validUntil = result.validUntil;
			this.windowSeconds = result.windowSeconds;
			this.now = Date.now();
			this.status = 'active';
		} catch (error) {
			this.status = 'error';
			this.error = error instanceof Error ? error.message : 'generate-failed';
			throw error;
		}
	}

	async complete(): Promise<CompletePairingOutput | undefined> {
		if (!this.code) return undefined;
		this.status = 'pairing';
		this.error = null;
		try {
			const result = await rpc.pairing.completePairing({ code: this.code });
			if (result.paired) {
				this.status = 'paired';
				this.deviceId = result.device_id ?? null;
				this.subStatus = result.sub_status ?? null;
			} else {
				this.status = 'error';
				this.error = result.error ?? 'pair-failed';
			}
			return result;
		} catch (error) {
			this.status = 'error';
			this.error = error instanceof Error ? error.message : 'pair-failed';
			throw error;
		}
	}

	startCountdown(): void {
		this.stopCountdown();
		this.now = Date.now();
		this.#ticker = setInterval(() => {
			this.now = Date.now();
		}, COUNTDOWN_INTERVAL_MS);
	}

	stopCountdown(): void {
		if (this.#ticker !== null) {
			clearInterval(this.#ticker);
			this.#ticker = null;
		}
	}

	reset(): void {
		this.stopCountdown();
		this.code = null;
		this.validUntil = 0;
		this.windowSeconds = 0;
		this.status = 'idle';
		this.error = null;
		this.deviceId = null;
		this.subStatus = null;
	}
}
