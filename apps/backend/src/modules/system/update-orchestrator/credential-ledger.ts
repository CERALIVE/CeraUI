import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { CredentialExpiry } from "./credential-expiry.ts";
import { saveCredentialLedger } from "./credential-ledger-io.ts";
import {
	CREDENTIAL_THRESHOLDS,
	type CredentialIntent,
	type CredentialLedgerState,
	credentialLedgerSchema,
	credentialThresholdsAt,
	MAX_CREDENTIAL_GENERATIONS,
} from "./credential-ledger-state.ts";
import { readPublicCredentialFile } from "./credential-public-file.ts";
import { syncOrchestratorDirectory } from "./orchestrator-directory-sync.ts";
import { ORCHESTRATOR_STATE_FILE } from "./persistence.ts";
import {
	decodeAuthorityUtf8,
	parseAuthorityJson,
} from "./strict-authority-json.ts";

export const CREDENTIAL_NOTICES_FILE = join(
	dirname(ORCHESTRATOR_STATE_FILE),
	"credential-notices.json",
);
export class CredentialLedgerError extends Error {
	constructor(
		readonly reason: "unavailable" | "capacity" | "identity-mismatch",
	) {
		super(`credential-ledger-${reason}`);
	}
}
export type CredentialNoticePlan = {
	readonly current?: CredentialIntent;
	readonly retired: readonly CredentialIntent[];
};
export type CredentialLedgerOptions = {
	readonly path?: string;
	readonly write?: (path: string, contents: string) => void;
	readonly syncParent?: (path: string) => void;
};

export class CredentialNoticeLedger {
	private readonly path: string;
	private readonly write: (path: string, contents: string) => void;
	private readonly syncParent: (path: string) => void;
	constructor(options: CredentialLedgerOptions = {}) {
		this.path = options.path ?? CREDENTIAL_NOTICES_FILE;
		this.write = options.write ?? saveCredentialLedger;
		this.syncParent = options.syncParent ?? syncOrchestratorDirectory;
	}

	private load(): CredentialLedgerState {
		try {
			const bytes = readPublicCredentialFile(this.path, 1_048_576).bytes;
			const state = credentialLedgerSchema.parse(
				parseAuthorityJson(decodeAuthorityUtf8(bytes)),
			);
			// A readable rename after failed directory fsync is not yet a durable acknowledgement.
			this.syncParent(this.path);
			return state;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return { schema: 1, currentGeneration: null, generations: [] };
			throw new CredentialLedgerError("unavailable");
		}
	}

	private save(state: CredentialLedgerState): void {
		try {
			this.write(this.path, JSON.stringify(state));
			this.syncParent(this.path);
		} catch {
			throw new CredentialLedgerError("unavailable");
		}
	}

	observe(
		known: Extract<CredentialExpiry, { kind: "known" }>,
		now: number,
	): CredentialNoticePlan {
		if (!Number.isSafeInteger(now))
			throw new CredentialLedgerError("unavailable");
		const state = this.load();
		const previous = JSON.stringify(state);
		let current = state.generations.find(
			(entry) => entry.digest === known.digest,
		);
		if (!current) {
			if (state.generations.length >= MAX_CREDENTIAL_GENERATIONS)
				throw new CredentialLedgerError("capacity");
			current = {
				digest: known.digest,
				expiresAt: known.expiresAt,
				id: randomUUID(),
				notices: {},
			};
			state.generations.push(current);
		}
		if (current.expiresAt !== known.expiresAt)
			throw new CredentialLedgerError("identity-mismatch");
		state.currentGeneration = current.id;
		const eligible = credentialThresholdsAt(known.expiresAt, now);
		const urgent = eligible.at(-1);
		for (const threshold of eligible) {
			current.notices[threshold] ??=
				threshold === urgent ? "pending" : "superseded";
		}
		const retired: CredentialIntent[] = [];
		let intent: CredentialIntent | undefined;
		for (const generation of state.generations) {
			for (const parsed of CREDENTIAL_THRESHOLDS) {
				const status = generation.notices[parsed];
				if (status === undefined) continue;
				const entry: CredentialIntent = {
					generation: generation.id,
					threshold: parsed,
				};
				if (
					generation.id === current.id &&
					parsed === urgent &&
					(status === "pending" || status === "active")
				)
					intent = entry;
				else {
					if (status === "pending" || status === "active")
						generation.notices[parsed] = "superseded";
					retired.push(entry);
				}
			}
		}
		if (previous !== JSON.stringify(state)) this.save(state);
		return { ...(intent ? { current: intent } : {}), retired };
	}

	activate(intent: CredentialIntent): void {
		this.transition(intent, "active");
	}
	acknowledge(intent: CredentialIntent): void {
		this.transition(intent, "acknowledged");
	}
	private transition(
		intent: CredentialIntent,
		next: "active" | "acknowledged",
	): void {
		const state = this.load();
		const generation = state.generations.find(
			(entry) => entry.id === intent.generation,
		);
		const status = generation?.notices[intent.threshold];
		if (!generation || status === undefined)
			throw new CredentialLedgerError("identity-mismatch");
		if (status === "acknowledged" || status === "superseded") return;
		generation.notices[intent.threshold] = next;
		this.save(state);
	}
}
