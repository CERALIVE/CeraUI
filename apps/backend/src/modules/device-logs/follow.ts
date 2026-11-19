// allow: SIZE_OK - Socket lifetime state machine; the clear fence shares slot ownership.
import {
	journalCursorBoot,
	LOG_FOLLOW_BOOT_START_PREFIX,
	type LogFollowMessage,
	type LogFollowStartInput,
	type LogFollowStartOutput,
	type LogFollowStopOutput,
	logFollowStartInputSchema,
} from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import {
	spawnWatcher,
	type WatcherOptions,
} from "../../helpers/spawn-policy.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { currentBootId } from "./boot-id.ts";
import { bindQuery, encodePosition } from "./continuation.ts";
import { compileFilter } from "./filter.ts";
import { createFollowDelivery } from "./follow-delivery.ts";
import { resolveFollowPosition } from "./follow-position.ts";
import { joinFollowProcess } from "./follow-stream.ts";
import {
	createFollowTransport,
	type FollowSocket,
} from "./follow-transport.ts";
import {
	followMockJournal,
	mockJournalRetentionBoundary,
	scanMockJournal,
} from "./mock-journal.ts";
import type { RawJournalRecord } from "./parse.ts";
import {
	JOURNAL_OUTPUT_FIELDS,
	type JournalClock,
	JournalReadError,
	scanJournal,
} from "./reader.ts";
import {
	getLogState,
	historyClearAwaitingSettlement,
	historyClearing,
} from "./settings.ts";
import { JournalSignalError } from "./termination.ts";

interface FollowOptions extends Pick<WatcherOptions, "spawn"> {
	readonly clock?: Pick<JournalClock, "setTimeout" | "clearTimeout">;
	readonly sessionSignal?: AbortSignal;
}
interface FollowSlot {
	readonly controller: AbortController;
	readonly done: Promise<void>;
	readonly cancelTimer: () => void;
	readonly sendEnd: (reason: "cleared") => void;
	checkpoint: string | null;
}
const running = new Map<FollowSocket, FollowSlot>();
const clock: Pick<JournalClock, "setTimeout" | "clearTimeout"> = {
	setTimeout: (callback, delay) => Number(setTimeout(callback, delay)),
	clearTimeout: (timer) => clearTimeout(timer),
};

export async function stopFollow(
	conn: FollowSocket,
): Promise<LogFollowStopOutput> {
	const slot = running.get(conn);
	if (!slot) return { success: false, checkpointCursor: null };
	slot.cancelTimer();
	slot.controller.abort();
	await slot.done;
	return { success: true, checkpointCursor: slot.checkpoint };
}

export async function stopAllFollows(reason: "cleared"): Promise<void> {
	const slots = [...running.entries()];
	for (const [, slot] of slots) slot.sendEnd(reason);
	await Promise.all(slots.map(([conn]) => stopFollow(conn)));
}

export async function startFollow(
	conn: FollowSocket,
	input: LogFollowStartInput,
	options: FollowOptions = {},
): Promise<LogFollowStartOutput> {
	const epoch = getLogState().historyEpoch;
	const filter = logFollowStartInputSchema.parse(input);
	const { sessionSignal } = options;
	const revoked = Promise.withResolvers<void>();
	const revoke = () => revoked.resolve();
	sessionSignal?.addEventListener("abort", revoke, { once: true });
	try {
		for (;;) {
			if (sessionSignal?.aborted || epoch !== getLogState().historyEpoch)
				return { ok: false, error: "READ_FAILED" };
			if (historyClearAwaitingSettlement()) return { ok: false, error: "BUSY" };
			const gate = historyClearing();
			const wait = gate ?? (running.has(conn) ? stopFollow(conn) : undefined);
			if (!wait) break;
			await Promise.race([wait, revoked.promise]);
		}
	} finally {
		sessionSignal?.removeEventListener("abort", revoke);
	}
	if (running.size >= 4) return { ok: false, error: "BUSY" };
	const bootId = currentBootId();
	if (bootId === undefined) return { ok: false, error: "BOOT_UNAVAILABLE" };
	const bootIdentity = `${LOG_FOLLOW_BOOT_START_PREFIX}${bootId}:${epoch}`;
	const mock = shouldUseMocks();
	const scan = mock ? scanMockJournal : scanJournal;
	const time = options.clock ?? clock;
	const controller = new AbortController();
	const transport = createFollowTransport(conn, sessionSignal);
	const settled = Promise.withResolvers<void>();
	const ready = Promise.withResolvers<LogFollowStartOutput>();
	const subscriptionId = crypto.randomUUID();
	let started = false;
	let ended = false;
	let cancelPending: (() => void) | undefined;
	const cancelTimer = () => cancelPending?.();
	const retireSession = () => {
		cancelTimer();
		controller.abort();
	};
	const publish = (message: LogFollowMessage) => {
		if (
			sessionSignal?.aborted ||
			ended ||
			(message.ended === undefined && controller.signal.aborted)
		)
			return;
		if (message.ended !== undefined) ended = true;
		const status = transport.send(message, slot.checkpoint);
		if (status === "accepted") {
			slot.checkpoint = message.checkpointCursor;
			return;
		}
		ended = true;
		retireSession();
	};
	const slot: FollowSlot = {
		controller,
		done: settled.promise,
		checkpoint: null,
		cancelTimer: () => cancelTimer(),
		sendEnd: (ended) =>
			publish({
				subscriptionId,
				entries: [],
				checkpointCursor: slot.checkpoint,
				dropped: 0,
				ended,
			}),
	};
	sessionSignal?.addEventListener("abort", retireSession, { once: true });
	running.set(conn, slot);
	const position = (cursor?: string) =>
		resolveFollowPosition(scan, { bootId, signal: controller.signal }, cursor);
	const { matches } = compileFilter(filter, { bootId });
	void (async () => {
		try {
			const after = filter.afterCursor;
			const boundary = mock ? mockJournalRetentionBoundary() : undefined;
			const bootStart =
				boundary === undefined ? bootIdentity : `${bootIdentity}:${boundary}`;
			const bootResume =
				after === bootIdentity ||
				after?.startsWith(`${bootIdentity}:`) === true;
			const bootToken = after?.startsWith(LOG_FOLLOW_BOOT_START_PREFIX);
			const priorBoot =
				after === undefined ? undefined : journalCursorBoot(after);
			const bootChanged = priorBoot !== undefined && priorBoot !== bootId;
			let cursor = bootToken || bootChanged ? null : await position(after);
			const retained = mock && after === bootStart;
			if (
				!bootChanged &&
				after !== undefined &&
				(bootResume ? !retained : cursor !== after)
			) {
				publish({
					subscriptionId,
					entries: [],
					checkpointCursor: null,
					dropped: 0,
					gap: "cursor_unavailable",
				});
				if (!bootResume) cursor = await position();
			}
			slot.checkpoint = cursor ?? bootStart;
			for (;;) {
				controller.signal.throwIfAborted();
				const local = new AbortController();
				const abort = () => local.abort();
				controller.signal.addEventListener("abort", abort);
				const delivery = createFollowDelivery({
					cursor: cursor ?? bootStart,
					filter,
					clock: time,
					signal: local.signal,
					abort,
					send: (batch) =>
						publish({
							subscriptionId,
							entries: batch.entries,
							checkpointCursor: batch.checkpointCursor,
							dropped: batch.dropped,
							...(batch.gap ? { gap: batch.gap } : {}),
						}),
				});
				cancelPending = delivery.cancel;
				const positionOptions = [
					...(cursor === null ? [] : [`--cursor=${cursor}`]),
					"--lines=all",
				];
				try {
					const handle = mock
						? followMockJournal({
								options: positionOptions,
								matches,
								signal: local.signal,
								onRecord: delivery.onRecord,
							})
						: nativeFollow(
								positionOptions,
								matches,
								{ ...options, clock: time },
								local,
								delivery.onRecord,
							);
					if (!started) {
						started = true;
						ready.resolve({
							ok: true,
							subscriptionId,
							checkpointCursor: slot.checkpoint,
						});
					}
					await handle.exited;
				} finally {
					controller.signal.removeEventListener("abort", abort);
					cancelTimer();
				}
				if (controller.signal.aborted) return;
				if (!delivery.restart) {
					const batch = delivery.batch;
					publish({
						subscriptionId,
						entries: batch.entries,
						checkpointCursor: batch.checkpointCursor,
						dropped: batch.dropped,
						...(batch.gap ? { gap: batch.gap } : {}),
						ended: "follower_exit",
					});
					return;
				}
				const from = cursor ?? bootStart;
				cursor = await resolveFollowPosition(scan, {
					bootId,
					signal: controller.signal,
					matches,
				});
				const gapFrom =
					cursor === null
						? undefined
						: encodePosition(
								from,
								bindQuery(
									{
										...filter,
										boot: "current",
										direction: "newer",
										limit: 100,
									},
									bootId,
									epoch,
								),
								{ through: cursor, start: true },
							);
				publish({
					subscriptionId,
					entries: [],
					checkpointCursor: cursor ?? bootStart,
					dropped: 0,
					gap: "catchup_exceeded",
					...(gapFrom !== undefined && gapFrom.length <= 2048
						? { gapFrom }
						: {}),
				});
			}
		} catch (error) {
			if (error instanceof JournalSignalError)
				logger.warn("Journal follower signal failed after reap", {
					module: "device-logs",
					signal: error.signal,
				});
			if (!started)
				ready.resolve({
					ok: false,
					error: error instanceof JournalReadError ? error.code : "READ_FAILED",
				});
			else if (!controller.signal.aborted)
				publish({
					subscriptionId,
					entries: [],
					checkpointCursor: slot.checkpoint,
					dropped: 0,
					ended: "follower_exit",
				});
		} finally {
			cancelTimer();
			sessionSignal?.removeEventListener("abort", retireSession);
			running.delete(conn);
			settled.resolve();
		}
	})();
	return ready.promise;
}

function nativeFollow(
	position: string[],
	matches: string[],
	options: FollowOptions & {
		readonly clock: Pick<JournalClock, "setTimeout" | "clearTimeout">;
	},
	controller: AbortController,
	onRecord: (record: RawJournalRecord) => "continue" | "stop",
) {
	const handle = spawnWatcher(
		[
			"journalctl",
			"-f",
			"-o",
			"json",
			"--all",
			`--output-fields=${JOURNAL_OUTPUT_FIELDS}`,
			...position,
			"--",
			...matches,
		],
		options,
	);
	const exited = joinFollowProcess(handle, {
		signal: controller.signal,
		clock: options.clock,
		onRecord,
	});
	return { exited };
}
