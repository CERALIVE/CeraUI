import { clearInterval, setInterval } from "node:timers";
import type {
	LogDeleteOlderFilesOutput,
	LogRetention,
	LogStorageOutput,
} from "@ceraui/rpc/schemas";
import {
	clearRecentLogLines,
	logger,
	setJournalDetail,
} from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { updatePhaseBusyReasons } from "../system/disruptive-action-gate.ts";
import { reserveUpdateEvidenceDeletion } from "../system/disruptive-action-reservation.ts";
import { isUpdating } from "../system/software-updates.ts";
import { getOrchestratorState } from "../system/update-orchestrator/runtime.ts";
import { listBoots } from "./boots.ts";
import { readJournalCeiling } from "./ceiling.ts";
import { clearNativeJournal } from "./clear-journal.ts";
import { abortLogExports } from "./export.ts";
import { stopAllFollows } from "./follow.ts";
import { deleteOlderJournal } from "./older-journal.ts";
import { abortLogQueries } from "./query-admission.ts";
import { deleteLegacyDebugFiles } from "./retention-files.ts";
import {
	beginHistoryClear,
	deferHistoryClear,
	getLogSettings,
	historyClearAwaitingSettlement,
	saveLogSettings,
	updateLogState,
} from "./settings.ts";
import { getStorage, readJournalUsage, readOldestEntry } from "./storage.ts";

export { parseDiskUsage, readJournalCeiling } from "./ceiling.ts";
export { getStorage } from "./storage.ts";

let tail: Promise<unknown> = Promise.resolve();
let daily: ReturnType<typeof setInterval> | undefined;
const busy = { ok: false, error: "BUSY" } as const;
function exclusive<T, R>(
	operation: () => Promise<T>,
	refused: R,
): Promise<T | R> {
	if (historyClearAwaitingSettlement()) return Promise.resolve(refused);
	const result = tail.then<T | R>(() =>
		historyClearAwaitingSettlement() ? refused : operation(),
	);
	tail = result.catch(() => undefined);
	return result;
}
function ceiling() {
	return shouldUseMocks()
		? { maxSizeMb: 256, maxAgeDays: 30 }
		: readJournalCeiling();
}
function active(): boolean {
	const settings = getLogSettings();
	return (
		ceiling() !== null &&
		(settings.maxAgeDays !== null || settings.maxSizeMb !== null)
	);
}
function schedule(): void {
	if (daily !== undefined) clearInterval(daily);
	daily = undefined;
	if (active()) {
		daily = setInterval(
			() => {
				void maintain().catch((error: unknown) => {
					logger.warn("Log maintenance state could not be saved", {
						module: "device-logs",
						error,
					});
				});
			},
			24 * 60 * 60 * 1000,
		);
		daily.unref();
	}
}
async function maintenance(): Promise<void> {
	if (!active()) return;
	const settings = getLogSettings();
	const args = [
		...(settings.maxAgeDays === null
			? []
			: [`--vacuum-time=${settings.maxAgeDays}d`]),
		...(settings.maxSizeMb === null
			? []
			: [`--vacuum-size=${settings.maxSizeMb}M`]),
	];
	let ok = true;
	try {
		if (!shouldUseMocks()) await run("journalctl", args);
	} catch {
		ok = false;
	}
	const journalBytes = await readJournalUsage();
	const oldest = await readOldestEntry();
	const sizeMet =
		settings.maxSizeMb === null ||
		(journalBytes !== null && journalBytes <= settings.maxSizeMb * 1024 * 1024);
	const ageMet =
		settings.maxAgeDays === null ||
		(oldest.known &&
			(oldest.ts === null ||
				oldest.ts >= Date.now() - settings.maxAgeDays * 86400000));
	updateLogState({
		lastMaintenance: { at: Date.now(), ok, targetMet: ok && sizeMet && ageMet },
	});
}
export function maintain(): Promise<void> {
	return exclusive(maintenance, undefined);
}
export async function initLogRetention(): Promise<void> {
	schedule();
	await maintain();
}
export function setRetention(next: LogRetention): Promise<LogStorageOutput> {
	return exclusive<LogStorageOutput, typeof busy>(async () => {
		const limit = ceiling();
		const { maxAgeDays, maxSizeMb } = next;
		if (
			(maxAgeDays !== null &&
				(limit === null || maxAgeDays > limit.maxAgeDays)) ||
			(maxSizeMb !== null && (limit === null || maxSizeMb > limit.maxSizeMb))
		)
			return { ok: false, error: "INVALID_RETENTION" };
		try {
			saveLogSettings(next);
			schedule();
			setJournalDetail(next.detail);
			await maintenance();
			return { ok: true, storage: await getStorage() };
		} catch {
			return { ok: false, error: "READ_FAILED" };
		}
	}, busy);
}
export function deleteOlderFiles(): Promise<LogDeleteOlderFilesOutput> {
	return withDestructiveRetention(false, async () => {
		const mock = shouldUseMocks();
		const bootsBefore = mock ? 1 : await countStoredBoots();
		const warnings = mock ? {} : await deleteOlderJournal();
		const bootsAfter = mock ? 1 : await countStoredBoots();
		return {
			ok: true,
			storage: await getStorage(),
			bootsBefore,
			bootsAfter,
			...warnings,
		};
	});
}

async function countStoredBoots(): Promise<number> {
	return (await listBoots()).filter((boot) => boot.logsAvailable).length;
}
export function deleteLegacyDebug(): Promise<LogStorageOutput> {
	return exclusive<LogStorageOutput, typeof busy>(async () => {
		try {
			await deleteLegacyDebugFiles();
			return { ok: true, storage: await getStorage() };
		} catch {
			return { ok: false, error: "READ_FAILED" };
		}
	}, busy);
}
export function clearAll(): Promise<LogDeleteOlderFilesOutput> {
	return withDestructiveRetention(true, async (retainUntil) => {
		const mock = shouldUseMocks();
		const bootsBefore = await countStoredBoots();
		if (!mock) await clearNativeJournal(retainUntil);
		await deleteLegacyDebugFiles();
		// Mock Clear empties the captured ring before writing its first new marker.
		if (mock) clearRecentLogLines();
		logger.info("device logs cleared", { module: "device-logs" });
		updateLogState({ lastClearedAt: Date.now() });
		const bootsAfter = await countStoredBoots();
		return { ok: true, storage: await getStorage(), bootsBefore, bootsAfter };
	});
}

function updateBusy(): boolean {
	return (
		isUpdating() ||
		updatePhaseBusyReasons(getOrchestratorState().phase).length > 0
	);
}

type DestructiveReply = { readonly ok: true };
function withDestructiveRetention<R extends DestructiveReply>(
	stopFollows: boolean,
	operation: (retainUntil: (pending: Promise<unknown>) => void) => Promise<R>,
): Promise<R | Extract<LogStorageOutput, { ok: false }>> {
	return exclusive<R | Extract<LogStorageOutput, { ok: false }>, typeof busy>(
		async () => {
			let reopen: (() => void) | undefined;
			let release: (() => void) | undefined;
			let settlement: Promise<unknown> | undefined;
			try {
				if (updateBusy()) return { ok: false, error: "UPDATE_IN_PROGRESS" };
				reopen = beginHistoryClear();
				const stopping = [
					...(stopFollows ? [stopAllFollows("cleared")] : []),
					abortLogExports(),
					abortLogQueries(),
				];
				const deadline = Promise.withResolvers<null>();
				const timer = setTimeout(() => deadline.resolve(null), 15_000);
				let drained: PromiseSettledResult<void>[] | null;
				try {
					drained = await Promise.race([
						Promise.allSettled(stopping),
						deadline.promise,
					]);
				} finally {
					clearTimeout(timer);
				}
				if (
					drained === null ||
					drained.some((result) => result.status === "rejected")
				)
					return { ok: false, error: "READ_FAILED" };
				const deletion = reserveUpdateEvidenceDeletion(updateBusy());
				if (!deletion.allowed)
					return { ok: false, error: "UPDATE_IN_PROGRESS" };
				release = deletion.reservation.releaseAfterCompletion;
				return await operation((pending) => {
					settlement = pending;
				});
			} catch {
				return { ok: false, error: "READ_FAILED" };
			} finally {
				const finish = () => {
					release?.();
					reopen?.();
				};
				if (settlement) {
					deferHistoryClear();
					void settlement.then(finish, () => undefined);
				} else finish();
			}
		},
		busy,
	);
}
