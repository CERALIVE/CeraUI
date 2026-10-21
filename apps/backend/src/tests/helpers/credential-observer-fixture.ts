import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialExpiry } from "../../modules/system/update-orchestrator/credential-expiry.ts";
import { CredentialNoticeLedger } from "../../modules/system/update-orchestrator/credential-ledger.ts";
import {
	CredentialNoticeObserver,
	type CredentialObserverDeps,
} from "../../modules/system/update-orchestrator/credential-notice-observer.ts";
import {
	notifyUpdate,
	type UpdateNotice,
} from "../../modules/system/update-orchestrator/notifications.ts";

export const CREDENTIAL_DAY = 86_400_000;
export async function credentialObserverFixture(
	overrides: Partial<CredentialObserverDeps> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "credential-observer-"));
	const path = join(root, "ledger.json");
	const state: { now: number; observation: CredentialExpiry; reads: number } = {
		now: 100 * CREDENTIAL_DAY,
		reads: 0,
		observation: {
			kind: "known",
			expiresAt: 180 * CREDENTIAL_DAY,
			digest: "a".repeat(64),
		},
	};
	const published: UpdateNotice[] = [];
	const ledger = new CredentialNoticeLedger({ path });
	const deps: CredentialObserverDeps = {
		now: () => state.now,
		read: async () => {
			state.reads++;
			return state.observation;
		},
		ledger,
		dismissed: () => false,
		clear: () => undefined,
		publish: (notice, beforeDismiss) => {
			published.push(notice);
			return notifyUpdate(notice, { beforeDismiss });
		},
		...overrides,
	};
	const observer = new CredentialNoticeObserver(deps);
	return {
		root,
		path,
		state,
		ledger,
		deps,
		observer,
		published,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}
