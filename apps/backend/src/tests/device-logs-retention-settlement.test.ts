import { expect, spyOn, test } from "bun:test";
import type { Subprocess } from "bun";
import { run } from "../helpers/run.ts";
import {
	createBundle,
	handleLogBundleRequest,
} from "../modules/device-logs/bundle.ts";
import {
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import { startFollow, stopFollow } from "../modules/device-logs/follow.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import { clearAll } from "../modules/device-logs/retention.ts";
import { installUpdatesNow } from "../modules/system/update-orchestrator/runtime.ts";
import { bounded, historyFixture, turn } from "./helpers/history-clear.ts";
import {
	cleanScopedFixture,
	scopedFixture,
} from "./helpers/package-scoped-install.ts";

const realRun = run;

test.each([
	{ command: "--rotate", status: 0, signals: [] },
	{ command: "--vacuum-time=1s", status: 137, signals: ["SIGTERM", "SIGKILL"] },
	{ command: "--rotate", status: 1, signals: [] },
])(
	"failed Clear keeps admissions closed for $command until positive settlement (exit $status)",
	async ({ command, status, signals }) => {
		const h = historyFixture(false);
		const update = scopedFixture();
		h.f.phase.mockRestore();
		const exit = Promise.withResolvers<number>();
		const barrier = h.ownedLatch();
		const stdout = new ReadableStream<Uint8Array<ArrayBuffer>>();
		const stderr = new ReadableStream<Uint8Array<ArrayBuffer>>();
		const delivered: (number | NodeJS.Signals | undefined)[] = [];
		const unused = () => {
			throw new Error("unexpected subprocess operation");
		};
		const child = {
			stdin: undefined,
			stdout,
			stderr,
			readable: stdout,
			terminal: undefined,
			stdio: [null, null, null],
			pid: 1,
			exited: exit.promise,
			exitCode: null,
			signalCode: null,
			killed: false,
			kill(signal) {
				delivered.push(signal);
			},
			ref: unused,
			unref: unused,
			send: unused,
			disconnect: unused,
			resourceUsage: unused,
			[Symbol.asyncDispose]: unused,
		} satisfies Subprocess<"ignore", "pipe", "pipe">;
		const normalRun = h.f.run.getMockImplementation();
		const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(child);
		const bundleRequest = (url: string) => new Request(`http://device${url}`);
		try {
			if (!normalRun) throw new Error("missing journal fixture");
			const oldBundle = await bounded(createBundle({}));
			if (!oldBundle.ok) throw new Error(oldBundle.error);
			let submitted = 0;
			h.f.run.mockImplementation((bin, args, opts) => {
				if (args[0] === command && ++submitted === 1)
					return realRun(bin, args, { ...opts, timeout: 0 });
				if (args[0] === "--sync") return h.own(barrier.hold().then(() => ""));
				return normalRun(bin, args, opts);
			});
			expect(await bounded(h.own(clearAll()))).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			const checkRefused = async () => {
				expect(await bounded(installUpdatesNow({ scope: "packages" }))).toEqual(
					{
						started: false,
						reason: "busy",
					},
				);
				expect(update.launches()).toBe(0);
				expect(await bounded(queryLogs({}, {}))).toEqual({
					ok: false,
					error: "BUSY",
				});
				expect(await bounded(startFollow(h.socket(), {}))).toEqual({
					ok: false,
					error: "BUSY",
				});
				expect((await bounded(createExport({}, { filter: {} }))).ok).toBe(
					false,
				);
				expect((await bounded(createBundle({}))).ok).toBe(false);
				expect(
					(await bounded(handleLogBundleRequest(bundleRequest(oldBundle.url))))
						.status,
				).toBe(403);
				expect(await bounded(h.own(clearAll()))).toEqual({
					ok: false,
					error: "BUSY",
				});
			};
			await checkRefused();
			expect(delivered).toEqual([...signals]);
			expect(submitted).toBe(1);

			exit.resolve(status);
			if (command === "--rotate" && status !== 0) {
				await bounded(barrier.entered);
				await checkRefused();
				barrier.release();
			}
			await turn();
			expect((await bounded(queryLogs({}, {}))).ok).toBe(true);
			const follower = await bounded(h.start());
			expect((await bounded(stopFollow(follower.conn))).success).toBe(true);
			const exported = await bounded(createExport({}, { filter: {} }));
			if (!exported.ok) throw new Error(exported.error);
			const exportReply = await bounded(
				handleLogExportRequest(bundleRequest(exported.url)),
			);
			expect(exportReply.status).toBe(200);
			await exportReply.body?.cancel();
			const bundle = await bounded(createBundle({}));
			if (!bundle.ok) throw new Error(bundle.error);
			const download = await bounded(
				handleLogBundleRequest(bundleRequest(bundle.url)),
			);
			expect(download.status).toBe(200);
			await download.body?.cancel();
			expect(
				(await bounded(handleLogBundleRequest(bundleRequest(bundle.url))))
					.status,
			).toBe(403);
			expect((await bounded(h.own(clearAll()))).ok).toBe(true);
			expect(submitted).toBe(2);
			expect(await bounded(installUpdatesNow({ scope: "packages" }))).toEqual({
				started: true,
			});
			expect(update.launches()).toBe(1);
		} finally {
			exit.resolve(status);
			barrier.release();
			spawn.mockRestore();
			await turn();
			try {
				await h.dispose();
			} finally {
				cleanScopedFixture();
			}
		}
	},
);
