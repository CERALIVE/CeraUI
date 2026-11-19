import { spyOn } from "bun:test";
import {
	LOG_FOLLOW_GAP_FROM,
	type LogFollowMessage,
	logFollowMessageSchema,
} from "@ceraui/rpc/schemas";
import type { ManagedProcess } from "../../helpers/spawn-policy.ts";
import * as mocks from "../../mocks/mock-service.ts";
import * as identity from "../../modules/device-logs/boot-id.ts";
import * as adapter from "../../modules/device-logs/mock-journal.ts";
import * as reader from "../../modules/device-logs/reader.ts";
import { manualClock } from "./device-journal.ts";
import { bootId, journal, record } from "./device-query.ts";

export { bootId, record };

export function followFixture() {
	const time = manualClock();
	const unplanned = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("unexpected native process in follow fixture");
	});
	const rows = [record(1)];
	const mock = spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	const boot = spyOn(identity, "currentBootId").mockReturnValue(bootId);
	const scan = spyOn(reader, "scanJournal").mockImplementation(journal(rows));
	const mockScan = spyOn(adapter, "scanMockJournal").mockImplementation(() => {
		throw new Error("unexpected mock scan in a native follow");
	});
	const children: ReturnType<typeof child>[] = [];
	const argv: string[][] = [];
	function child() {
		const exit = Promise.withResolvers<number>();
		let consumed: ReturnType<typeof Promise.withResolvers<void>> | undefined;
		let output: ReadableStreamDefaultController<Uint8Array>;
		let errors: ReadableStreamDefaultController<Uint8Array>;
		let closed = false;
		let outputClosed = false;
		let errorClosed = false;
		let errorOnKill = false;
		const proc: ManagedProcess = {
			stdout: new ReadableStream(
				{
					start(controller) {
						output = controller;
					},
					pull() {
						consumed?.resolve();
					},
					cancel() {
						outputClosed = true;
						consumed?.resolve();
					},
				},
				{ highWaterMark: 0 },
			),
			stderr: new ReadableStream({
				start(controller) {
					errors = controller;
				},
				cancel() {
					errorClosed = true;
				},
			}),
			exited: exit.promise,
			exitCode: null,
			signalCode: null,
			kill(signal) {
				finish(143, errorOnKill ? new Error("closed pipe") : undefined);
				signals.push(signal);
			},
		};
		const signals: Array<NodeJS.Signals | number | undefined> = [];
		function finish(code = 0, error?: Error) {
			if (closed) return;
			closed = true;
			proc.exitCode = code;
			if (!outputClosed) {
				outputClosed = true;
				if (error) output.error(error);
				else output.close();
			}
			if (!errorClosed) {
				errorClosed = true;
				errors.close();
			}
			exit.resolve(code);
			consumed?.resolve();
		}
		return {
			proc,
			signals,
			finish,
			failOnAbort() {
				errorOnKill = true;
			},
			async emitRaw(text: string) {
				consumed = Promise.withResolvers<void>();
				output.enqueue(new TextEncoder().encode(text));
				await consumed.promise;
			},
			async emit(records: ReturnType<typeof record>[]) {
				consumed = Promise.withResolvers<void>();
				const content = records
					.map((r) =>
						JSON.stringify({
							__CURSOR: r.cursor,
							__REALTIME_TIMESTAMP: String(r.ts * 1000),
							_BOOT_ID: r.bootId,
							_SYSTEMD_UNIT: "ceralive.service",
							PRIORITY: r.level === "error" ? "3" : "7",
							MESSAGE: r.message,
							MESSAGE_ID: r.messageId,
						}),
					)
					.join("\n");
				output.enqueue(new TextEncoder().encode(`${content}\n`));
				// Await consumption of this chunk, not an arbitrary clock delay.
				await consumed.promise;
			},
		};
	}
	const spawn = (args: string[]) => {
		argv.push(args);
		const result = child();
		children.push(result);
		return result.proc;
	};
	const messages: LogFollowMessage[] = [];
	const sent = Promise.withResolvers<void>();
	const conn = {
		data: { senderId: "viewer" },
		send(frame: string) {
			const parsed = JSON.parse(frame);
			const message = logFollowMessageSchema
				.omit({ gapFrom: true })
				.parse(parsed["logs.follow"]);
			messages.push(
				logFollowMessageSchema.parse({
					...message,
					...(Object.hasOwn(parsed, LOG_FOLLOW_GAP_FROM)
						? { gapFrom: parsed[LOG_FOLLOW_GAP_FROM] }
						: {}),
				}),
			);
			sent.resolve();
			return Buffer.byteLength(frame);
		},
	};
	return {
		time,
		rows,
		scan,
		mockScan,
		boot,
		mock,
		children,
		argv,
		conn,
		messages,
		sent: sent.promise,
		options: { clock: time.clock, spawn },
		restore() {
			scan.mockRestore();
			mockScan.mockRestore();
			boot.mockRestore();
			mock.mockRestore();
			unplanned.mockRestore();
		},
	};
}
