import { readFile } from "node:fs/promises";
import { clearInterval, setInterval } from "node:timers";
import {
	type LogDeleteOlderFilesOutput,
	type LogStorageOutput,
	logRetentionSchema,
} from "@ceraui/rpc/schemas";
import {
	clearRecentLogLines,
	logger,
	setJournalDetail,
} from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { updatePhaseBusyReasons } from "../system/disruptive-action-gate.ts";
import { getOrchestratorState } from "../system/update-orchestrator/runtime.ts";
import { listBoots } from "./boots.ts";
import { readJournalCeiling } from "./ceiling.ts";
import { abortLogExports } from "./export.ts";
import { stopAllFollows } from "./follow.ts";
import { abortLogQueries } from "./query-admission.ts";
import { deleteLegacyDebugFiles } from "./retention-files.ts";
import {
	beginHistoryClear,
	getLogSettings,
	saveLogSettings,
	updateLogState,
} from "./settings.ts";
import { getStorage, readJournalUsage, readOldestEntry } from "./storage.ts";

export { parseDiskUsage, readJournalCeiling } from "./ceiling.ts";
export { getStorage } from "./storage.ts";

let tail: Promise<unknown> = Promise.resolve();
let daily: ReturnType<typeof setInterval> | undefined;
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
	const result = tail.then(operation);
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
	return exclusive(maintenance);
}
export async function initLogRetention(): Promise<void> {
	schedule();
	await maintain();
}
export function setRetention(next: unknown): Promise<LogStorageOutput> {
	return exclusive(async () => {
		const parsed = logRetentionSchema.safeParse(next);
		if (!parsed.success) return { ok: false, error: "INVALID_RETENTION" };
		const limit = ceiling();
		const { maxAgeDays, maxSizeMb } = parsed.data;
		if (
			(maxAgeDays !== null &&
				(limit === null || maxAgeDays > limit.maxAgeDays)) ||
			(maxSizeMb !== null && (limit === null || maxSizeMb > limit.maxSizeMb))
		)
			return { ok: false, error: "INVALID_RETENTION" };
		try {
			saveLogSettings(parsed.data);
			schedule();
			setJournalDetail(parsed.data.detail);
			await maintenance();
			return { ok: true, storage: await getStorage() };
		} catch {
			return { ok: false, error: "READ_FAILED" };
		}
	});
}
export function deleteOlderFiles(): Promise<LogDeleteOlderFilesOutput> {
	return exclusive(async () => {
		try {
			if (shouldUseMocks())
				return {
					ok: true,
					storage: await getStorage(),
					bootsBefore: 1,
					bootsAfter: 1,
				};
			const bootsBefore = (await listBoots()).filter(
				(boot) => boot.logsAvailable,
			).length;
			await run("journalctl", ["--rotate"]);
			const text = await readFile("/proc/uptime", "utf8");
			const uptime = Number(/^\d+(?:\.\d+)?(?=\s)/.exec(text)?.[0]);
			const seconds = Math.ceil(uptime) + 60;
			if (!Number.isSafeInteger(seconds) || seconds < 60)
				return { ok: false, error: "READ_FAILED" };
			await run("journalctl", [`--vacuum-time=${seconds}s`]);
			const bootsAfter = (await listBoots()).filter(
				(boot) => boot.logsAvailable,
			).length;
			return { ok: true, storage: await getStorage(), bootsBefore, bootsAfter };
		} catch {
			return { ok: false, error: "READ_FAILED" };
		}
	});
}
export function deleteLegacyDebug(): Promise<LogStorageOutput> {
	return exclusive(async () => {
		try {
			await deleteLegacyDebugFiles();
			return { ok: true, storage: await getStorage() };
		} catch {
			return { ok: false, error: "READ_FAILED" };
		}
	});
}
export function clearAll(): Promise<LogStorageOutput> {
	return exclusive(async () => {
		let reopen: (() => void) | undefined;
		try {
			if (updatePhaseBusyReasons(getOrchestratorState().phase).length > 0)
				return { ok: false, error: "UPDATE_IN_PROGRESS" };
			reopen = beginHistoryClear();
			const stopping = [
				stopAllFollows("cleared"),
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
			const mock = shouldUseMocks();
			if (updatePhaseBusyReasons(getOrchestratorState().phase).length > 0)
				return { ok: false, error: "UPDATE_IN_PROGRESS" };
			if (!mock) {
				await run("journalctl", ["--rotate"]);
				await run("journalctl", ["--vacuum-time=1s"]);
			}
			await deleteLegacyDebugFiles();
			if (mock) clearRecentLogLines();
			logger.info("device logs cleared", { module: "device-logs" });
			updateLogState({ lastClearedAt: Date.now() });
			return { ok: true, storage: await getStorage() };
		} catch {
			return { ok: false, error: "READ_FAILED" };
		} finally {
			reopen?.();
		}
	});
}
