import { spyOn } from "bun:test";
import type { LogFollowMessage } from "@ceraui/rpc/schemas";
import * as atomic from "../../helpers/config-loader.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../../modules/device-logs/export.ts";
import * as follow from "../../modules/device-logs/follow.ts";
import * as mockJournal from "../../modules/device-logs/mock-journal.ts";
import { queryLogs } from "../../modules/device-logs/query.ts";
import { abortLogQueries } from "../../modules/device-logs/query-admission.ts";
import * as reader from "../../modules/device-logs/reader.ts";
import * as files from "../../modules/device-logs/retention-files.ts";
import * as settings from "../../modules/device-logs/settings.ts";
import { fakeJournal } from "./device-journal.ts";
import { historyInputs } from "./history-inputs.ts";

const realScan = reader.scanJournal;
const realMockFollow = mockJournal.followMockJournal;
const realDelete = files.deleteLegacyDebugFiles;
const realWrite = atomic.writeFileAtomicSync;
export async function bounded<T>(event: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			event,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("history-clear event deadline")),
					1000,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
export const turn = () =>
	bounded(new Promise<void>((resolve) => setImmediate(resolve)));
export function latch() {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		entered: entered.promise,
		release: () => released.resolve(),
		async hold() {
			entered.resolve();
			await released.promise;
		},
	};
}

export function historyFixture(mock: boolean) {
	const inputs = historyInputs(mock);
	const { time, scan, context, watches, socket, start } = inputs;
	const disposers: Array<() => void> = [];
	const releases: Array<() => void> = [];
	const tasks: Promise<unknown>[] = [];
	const own = <T>(task: Promise<T>): Promise<T> => {
		tasks.push(task.catch(() => undefined));
		return task;
	};
	const ownedLatch = () => {
		const result = latch();
		releases.push(result.release);
		return result;
	};
	const holdQuery = async (conn: object = {}) => {
		const gate = ownedLatch();
		const entered = Promise.withResolvers<void>();
		const child = fakeJournal([], { held: true });
		scan.mockImplementationOnce((input) => {
			entered.resolve();
			return realScan({
				...input,
				spawn: () => ({
					stdout: child.child.stdout,
					stderr: child.child.stderr,
					get signalCode() {
						return child.child.signalCode;
					},
					exited: child.child.exited.then(async (code) => {
						await gate.hold();
						return code;
					}),
					kill(signal) {
						child.child.kill(signal);
					},
				}),
			});
		});
		const task = own(queryLogs(conn, {}));
		await bounded(entered.promise);
		return { gate, task, conn, child };
	};
	const holdFollow = async () => {
		const gate = ownedLatch();
		const messages: LogFollowMessage[] = [];
		const conn = socket(messages);
		if (mock) {
			const adapter = spyOn(
				mockJournal,
				"followMockJournal",
			).mockImplementationOnce((input) => {
				const handle = realMockFollow(input);
				return {
					abort: handle.abort,
					exited: handle.exited.then(async (code) => {
						await gate.hold();
						return code;
					}),
				};
			});
			disposers.push(() => adapter.mockRestore());
			await start(conn);
		} else {
			const child = fakeJournal([], { held: true });
			const result = await follow.startFollow(
				conn,
				{},
				{
					clock: time.clock,
					spawn: () => ({
						stdout: child.child.stdout,
						stderr: child.child.stderr,
						get exitCode() {
							return child.child.signalCode === null ? null : 143;
						},
						get signalCode() {
							return child.child.signalCode;
						},
						exited: child.child.exited.then(async (code) => {
							await gate.hold();
							return code;
						}),
						kill() {
							child.child.kill("SIGTERM");
						},
					}),
				},
			);
			if (!result.ok) throw new Error(result.error);
		}
		return { gate, conn, messages };
	};
	const holdExport = async () => {
		const gate = ownedLatch();
		const metadataEntered = Promise.withResolvers<void>();
		const previous = await context();
		context.mockImplementationOnce(async () => {
			metadataEntered.resolve();
			await gate.hold();
			return previous;
		});
		const any = spyOn(AbortSignal, "any");
		const created = await createExport({}, { filter: {} });
		if (!created.ok) throw new Error(created.error);
		const response = await handleLogExportRequest(
			new Request(`http://device${created.url}`),
		);
		const body = response.body?.getReader();
		if (!body) throw new Error("missing export body");
		const pending = own(body.read());
		await bounded(metadataEntered.promise);
		const observed = any.mock.results.find(
			(result) =>
				result.type === "return" && result.value instanceof AbortSignal,
		);
		if (observed?.type !== "return" || !(observed.value instanceof AbortSignal))
			throw new Error("missing export signal");
		const stopped = Promise.withResolvers<void>();
		observed.value.addEventListener("abort", () => stopped.resolve(), {
			once: true,
		});
		any.mockRestore();
		return { gate, entered: stopped.promise, body, pending };
	};
	const holdReadout = () => {
		const gate = ownedLatch();
		disposers.push(inputs.holdReadout(gate.hold));
		return gate;
	};
	return {
		...inputs,
		own,
		holdQuery,
		holdFollow,
		holdExport,
		holdReadout,
		ownedLatch,
		holdRotate() {
			const gate = ownedLatch();
			inputs.journal.rotate = gate.hold;
			return gate;
		},
		holdVacuum() {
			const gate = ownedLatch();
			inputs.journal.vacuum = gate.hold;
			return gate;
		},
		holdUnlink() {
			const gate = ownedLatch();
			const remove = spyOn(
				files,
				"deleteLegacyDebugFiles",
			).mockImplementationOnce(async (...args) => {
				await gate.hold();
				return realDelete(...args);
			});
			disposers.push(() => remove.mockRestore());
			return gate;
		},
		onPersist(action: () => void) {
			const original = settings.getLogState().lastClearedAt;
			const write = spyOn(atomic, "writeFileAtomicSync").mockImplementation(
				(path, data) => {
					if (
						path.endsWith("log-state.json") &&
						JSON.parse(data).lastClearedAt !== original
					)
						action();
					realWrite(path, data);
				},
			);
			disposers.push(() => write.mockRestore());
		},
		async dispose() {
			for (const release of releases) release();
			for (const watch of watches) watch.finish();
			await bounded(
				Promise.all([
					follow.stopAllFollows("cleared"),
					abortLogExports(),
					abortLogQueries(),
				]),
			);
			await bounded(Promise.allSettled(tasks));
			await bounded(
				Promise.all([
					follow.stopAllFollows("cleared"),
					abortLogExports(),
					abortLogQueries(),
				]),
			);
			for (const dispose of disposers.reverse()) dispose();
			await inputs.dispose();
		},
	};
}
