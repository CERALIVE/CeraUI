import type { UpdateCredentials } from "@ceraui/rpc/schemas";
import { logger } from "../../../helpers/logger.ts";
import { isNotificationDismissed } from "../../ui/notification-dismissals.ts";
import {
	type CredentialExpiry,
	type CredentialExpiryReason,
	readCredentialExpiry,
} from "./credential-expiry.ts";
import {
	CredentialLedgerError,
	CredentialNoticeLedger,
} from "./credential-ledger.ts";
import {
	type CredentialIntent,
	credentialIntentId,
	credentialIntentKind,
} from "./credential-ledger-state.ts";
import {
	clearUpdateNotice,
	notifyUpdate,
	type UpdateNotice,
} from "./notifications.ts";

const READ_INTERVAL_MS = 15 * 60_000;
const OBSERVE_INTERVAL_MS = 60_000;
type CredentialFaultReason =
	| `reader-${CredentialExpiryReason}`
	| `ledger-${CredentialLedgerError["reason"]}`
	| "observation-failed";
export type CredentialObserverDeps = {
	readonly now: () => number;
	readonly read: () => Promise<CredentialExpiry>;
	readonly ledger: CredentialNoticeLedger;
	readonly publish: (notice: UpdateNotice, acknowledge: () => void) => boolean;
	readonly clear: (intent: CredentialIntent) => void;
	readonly dismissed: (name: string) => boolean;
};

export class CredentialNoticeObserver {
	private flight: Promise<void> | undefined;
	private readAt: number | undefined;
	private observedAt: number | undefined;
	private latestObservedAt: number | undefined;
	private observation: CredentialExpiry = {
		kind: "unavailable",
		reason: "missing",
	};
	private available = false;
	private stopped = false;
	private fault: CredentialFaultReason | undefined;
	constructor(private readonly deps: CredentialObserverDeps) {}

	refresh(force = false): Promise<void> {
		if (this.stopped) return Promise.resolve();
		if (this.flight) return this.flight;
		const flight = Promise.resolve()
			.then(async () => {
				const now = this.deps.now();
				if (!Number.isSafeInteger(now))
					throw new RangeError("credential-clock-unavailable");
				if (
					!force &&
					this.observedAt !== undefined &&
					now >= this.observedAt &&
					now - this.observedAt < OBSERVE_INTERVAL_MS
				)
					return;
				this.observedAt = now;
				await this.observe(now, force);
			})
			.catch((error: unknown) => {
				// Never attach raw reader/ledger exceptions to logs or let an advisory reject a tick.
				this.available = false;
				this.reportFault(
					error instanceof CredentialLedgerError
						? `ledger-${error.reason}`
						: "observation-failed",
				);
			})
			.finally(() => {
				if (this.flight === flight) this.flight = undefined;
			});
		this.flight = flight;
		return flight;
	}

	stop(): void {
		this.stopped = true;
	}

	private reportFault(reason: CredentialFaultReason | undefined): void {
		if (reason === this.fault) return;
		this.fault = reason;
		if (reason === undefined) return;
		try {
			logger.warn("update-orchestrator: credential observation deferred", {
				reason,
			});
		} catch {
			// Diagnostic transport faults cannot escape this advisory boundary or expose raw errors.
			this.available = false;
		}
	}

	details(): UpdateCredentials {
		if (!this.available) return { expiresAt: null, state: "unavailable" };
		const now = this.deps.now();
		if (
			!Number.isSafeInteger(now) ||
			(this.latestObservedAt !== undefined && now < this.latestObservedAt)
		)
			return { expiresAt: null, state: "unavailable" };
		switch (this.observation.kind) {
			case "unavailable":
				return { expiresAt: null, state: "unavailable" };
			case "known": {
				const remaining = this.observation.expiresAt - now;
				return {
					expiresAt: this.observation.expiresAt,
					state:
						remaining <= 0
							? "expired"
							: remaining <= 90 * 86_400_000
								? "expiring"
								: "valid",
				};
			}
			default: {
				const exhaustive: never = this.observation;
				return exhaustive;
			}
		}
	}

	private async observe(now: number, force: boolean): Promise<void> {
		if (
			force ||
			this.readAt === undefined ||
			now < this.readAt ||
			now - this.readAt >= READ_INTERVAL_MS
		) {
			this.observation = await this.deps.read();
			this.readAt = now;
		}
		if (this.stopped) return;
		switch (this.observation.kind) {
			case "unavailable":
				this.available = false;
				this.reportFault(`reader-${this.observation.reason}`);
				return;
			case "known":
				break;
			default: {
				const exhaustive: never = this.observation;
				return exhaustive;
			}
		}
		const plan = this.deps.ledger.observe(this.observation, this.deps.now());
		this.latestObservedAt = plan.latestObservedAt;
		this.available = true;
		for (const retired of plan.retired) this.deps.clear(retired);
		if (!plan.current) {
			this.reportFault(undefined);
			return;
		}
		const intent = plan.current;
		const kind = credentialIntentKind(intent);
		const id = credentialIntentId(intent);
		if (this.deps.dismissed(`update:${kind}:${id}`)) {
			this.deps.ledger.acknowledge(intent);
			this.deps.clear(intent);
			this.reportFault(undefined);
			return;
		}
		this.deps.ledger.activate(intent);
		const acknowledge = () => this.deps.ledger.acknowledge(intent);
		switch (intent.threshold) {
			case "expired":
				this.deps.publish({ kind: "credentials-expired", id }, acknowledge);
				break;
			case "90":
				this.deps.publish(
					{ kind: "credentials-expiring", id, days: 90 },
					acknowledge,
				);
				break;
			case "30":
				this.deps.publish(
					{ kind: "credentials-expiring", id, days: 30 },
					acknowledge,
				);
				break;
			case "7":
				this.deps.publish(
					{ kind: "credentials-expiring", id, days: 7 },
					acknowledge,
				);
				break;
			default: {
				const exhaustive: never = intent.threshold;
				return exhaustive;
			}
		}
		this.reportFault(undefined);
	}
}

const observer = new CredentialNoticeObserver({
	now: Date.now,
	read: readCredentialExpiry,
	ledger: new CredentialNoticeLedger(),
	publish: (notice, beforeDismiss) => notifyUpdate(notice, { beforeDismiss }),
	clear: (intent) =>
		clearUpdateNotice(credentialIntentKind(intent), credentialIntentId(intent)),
	dismissed: isNotificationDismissed,
});

export function observeCredentialNotices(force = false): Promise<void> {
	return observer.refresh(force);
}
export function credentialDetails(): UpdateCredentials {
	return observer.details();
}
