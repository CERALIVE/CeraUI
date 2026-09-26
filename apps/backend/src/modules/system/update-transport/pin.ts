import { RunAbortError, RunTimeoutError, run } from "../../../helpers/run.ts";
import { readUpdateCapabilityFile } from "../update-capabilities.ts";
import type { Family, RankedTransport, TransportSelection } from "./core.ts";
import {
	runPinnedStep,
	sweepUpdateRules,
	type UpdateJob,
	UpdatePinError,
} from "./pin-rules.ts";

export {
	UPDATE_TRANSPORT_RULE_PRIORITY,
	UPDATE_TRANSPORT_TABLE_BASE,
	UpdatePinError,
} from "./pin-rules.ts";
export const UPDATE_TRANSPORT_HOLD_MS = 15 * 60_000;
const MAX_ATTEMPTS = 3;
type CapabilityFile = NonNullable<
	Awaited<ReturnType<typeof readUpdateCapabilityFile>>
>;
type PinDeps = {
	readonly readCapabilities: () => Promise<CapabilityFile | undefined>;
	readonly run: typeof run;
	readonly now: () => number;
};

export class UpdateTransferError extends Error {
	constructor(
		readonly reason: "dns-failed" | "no-route" | "blocked" | "tls-error",
		cause?: unknown,
	) {
		super(`update transfer: ${reason}`, { cause });
		this.name = "UpdateTransferError";
	}
}

export function classifyUpdateTransferError(
	error: unknown,
): UpdateTransferError | undefined {
	if (error instanceof UpdateTransferError) return error;
	if (error instanceof RunAbortError) return undefined;
	if (error instanceof RunTimeoutError)
		return new UpdateTransferError("blocked", error);
	if (!(error instanceof Error)) return undefined;
	const code: unknown = "code" in error ? error.code : undefined;
	switch (code) {
		case 6:
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return new UpdateTransferError("dns-failed", error);
		case 7:
		case "ENETUNREACH":
		case "EHOSTUNREACH":
		case "ECONNREFUSED":
			return new UpdateTransferError("no-route", error);
		case 28:
		case "ETIMEDOUT":
		case "ECONNRESET":
			return new UpdateTransferError("blocked", error);
		case 35:
		case 60:
			return new UpdateTransferError("tls-error", error);
		default:
			return undefined;
	}
}

function uidFor(job: UpdateJob, file: CapabilityFile): number {
	const uid = job === "apt" ? file.apt_uid : file.ota_uid;
	// UID 0 would route the backend's own control sockets as well as the job.
	if (
		uid === 0 ||
		file.apt_uid === file.ota_uid ||
		!file.features.includes("transport-uidrange")
	)
		throw new UpdatePinError("capabilities-unavailable");
	return uid;
}

type Step<T> = (
	transport: RankedTransport,
	aptFlags: readonly string[],
) => Promise<T>;

export function createUpdatePinController(overrides: Partial<PinDeps> = {}) {
	const deps: PinDeps = {
		readCapabilities: readUpdateCapabilityFile,
		run,
		now: Date.now,
		...overrides,
	};
	const unhealthy = new Map<string, number>();
	const active = new Set<UpdateJob>();
	let swept = false;
	const key = (ifname: string, family: Family) => `${ifname}\0${family}`;
	const unhealthyUntil = (
		ifname: string,
		family: Family,
	): number | undefined => {
		const until = unhealthy.get(key(ifname, family));
		return until !== undefined && until > deps.now() ? until : undefined;
	};

	async function runStep<T>(
		job: UpdateJob,
		selection: TransportSelection,
		step: Step<T>,
	): Promise<T> {
		if (!swept) throw new UpdatePinError("sweep-required");
		if (active.has(job)) throw new UpdatePinError("busy");
		active.add(job);
		try {
			const file = await deps.readCapabilities();
			if (!file) throw new UpdatePinError("capabilities-unavailable");
			const uid = uidFor(job, file);
			const candidates = selection.ranked
				.filter(
					(row) =>
						row.healthy && !unhealthyUntil(row.candidate.ifname, row.family),
				)
				.slice(0, MAX_ATTEMPTS);
			if (!candidates.length) throw new UpdatePinError("no-transport");
			for (const [index, candidate] of candidates.entries()) {
				try {
					return await runPinnedStep({
						job,
						uid,
						transport: candidate,
						step,
						runner: deps.run,
					});
				} catch (error) {
					const transfer = classifyUpdateTransferError(error);
					if (!transfer) throw error;
					unhealthy.set(
						key(candidate.candidate.ifname, candidate.family),
						deps.now() + UPDATE_TRANSPORT_HOLD_MS,
					);
					if (index === candidates.length - 1) throw transfer;
				}
			}
			throw new UpdatePinError("no-transport");
		} finally {
			active.delete(job);
		}
	}

	async function sweep(): Promise<void> {
		if (active.size) throw new UpdatePinError("busy");
		swept = false;
		await sweepUpdateRules(deps.run);
		swept = true;
	}

	return { run: runStep, sweep, unhealthyUntil };
}

export const updatePinController = createUpdatePinController();
