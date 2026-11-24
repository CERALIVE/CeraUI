/**
 * The device itself behind the closed-loop harness: the backend's procedures,
 * config and broadcast in a child process. Its frames reach the store as the
 * exact bytes the socket carried, and its answers are the procedures' own.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { flushSync, tick } from "svelte";

import type { HeldCall } from "./device-loop";
import { ingestFrame } from "./device-loop";

const BACKEND = resolve("../backend");

interface Answer {
	readonly frames: readonly string[];
	readonly result?: unknown;
}

export interface RealDevice {
	call(method: string, input?: unknown): Promise<Answer>;
	/** Start over with this config; the store hears the device's own broadcast. */
	become(config: Record<string, unknown>): Promise<void>;
	/** Run a held call on the device and deliver its frames, then its answer. */
	answer(held: HeldCall): Promise<readonly string[]>;
	close(): void;
}

/** `beforeAll(async () => { device = await realDevice(); }, DEVICE_START_MS)`. */
export const DEVICE_START_MS = 60_000;
export async function realDevice(): Promise<RealDevice> {
	const cwd = mkdtempSync(join(tmpdir(), "harness-device-"));
	copyFileSync(join(BACKEND, "setup.json"), join(cwd, "setup.json"));
	const child: ChildProcessWithoutNullStreams = spawn(
		"bun",
		[join(BACKEND, "src/tests/helpers/config-device.ts")],
		{ cwd, env: { ...process.env, NODE_ENV: "test" } },
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const waiting: Array<PromiseWithResolvers<Answer>> = [];
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (line.startsWith("DEVICE "))
			waiting.shift()?.resolve(JSON.parse(line.slice("DEVICE ".length)));
	});
	child.on("exit", (code) => {
		for (const answer of waiting.splice(0))
			answer.reject(new Error(`device exited ${code}: ${stderr.slice(-2000)}`));
	});

	const call = (method: string, input?: unknown) => {
		const answer = Promise.withResolvers<Answer>();
		waiting.push(answer);
		child.stdin.write(`${JSON.stringify({ method, input })}\n`);
		return answer.promise;
	};
	const deliver = (frames: readonly string[]) => {
		for (const frame of frames) ingestFrame(frame);
	};

	// Its start-up is the caller's hook's time, not its first test's.
	await call("getConfig");

	return {
		call,
		become: async (config) => deliver((await call("become", config)).frames),
		answer: async (held) => {
			const { frames, result } = await call(held.method, held.input);
			deliver(frames);
			held.resolve(result);
			await tick();
			flushSync();
			return frames;
		},
		close: () => {
			child.kill();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}
