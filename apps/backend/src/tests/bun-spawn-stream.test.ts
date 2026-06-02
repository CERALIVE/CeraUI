/*
 * T8 spike — proves Bun.spawn streams stdout line-by-line (NOT buffered to
 * the end) and that process exit is detected promptly after the last line.
 *
 * This is the load-bearing assumption behind the future event-driven network
 * monitor (T12): a long-lived `nmcli monitor` / `mmcli --monitor-modems`
 * child must hand us each event line AS IT HAPPENS, not in one dump at exit.
 *
 * No hardware (nmcli/mmcli) is required — a short `bash` loop stands in for the
 * real monitor binary. Runs on any dev machine with bash + Bun.
 */
import { describe, expect, it } from "bun:test";

/** Wall-clock ms since an arbitrary epoch (monotonic enough for deltas). */
const now = () => performance.now();

type StreamedLine = {
	text: string;
	/** ms after spawn that this line was observed by the consumer. */
	at: number;
};

/**
 * Spawn `argv`, consuming stdout via the ReadableStream async-iterator and
 * splitting on newlines. Each completed line is recorded WITH the timestamp it
 * was observed — that timestamp trail is what proves incremental delivery.
 */
async function collectLinesIncrementally(argv: string[]): Promise<{
	lines: StreamedLine[];
	exitCode: number;
	exitAt: number;
	startAt: number;
}> {
	const startAt = now();
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });

	const lines: StreamedLine[] = [];
	const decoder = new TextDecoder();
	let buffer = "";

	// `proc.stdout` is a ReadableStream<Uint8Array>; Bun makes it async-iterable.
	// Iterating yields chunks AS they are written by the child, not at the end.
	for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });

		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const text = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			lines.push({ text, at: now() - startAt });
			newlineIndex = buffer.indexOf("\n");
		}
	}

	// Flush any trailing partial line (no terminating newline).
	buffer += decoder.decode();
	if (buffer.length > 0) {
		lines.push({ text: buffer, at: now() - startAt });
	}

	const exitCode = await proc.exited;
	const exitAt = now() - startAt;

	return { lines, exitCode, exitAt, startAt };
}

describe("Bun.spawn stdout streaming (T8 monitor-subscription spike)", () => {
	it("yields each line as it is emitted, not all-at-once at process exit", async () => {
		const N = 5;
		const delaySeconds = 0.1; // 100ms between lines

		const { lines, exitCode, exitAt } = await collectLinesIncrementally([
			"bash",
			"-c",
			`for i in 1 2 3 4 5; do echo line_$i; sleep ${delaySeconds}; done`,
		]);

		// --- N lines received, each with the expected content ---
		expect(lines).toHaveLength(N);
		for (let i = 0; i < N; i++) {
			expect(lines[i]?.text).toBe(`line_${i + 1}`);
		}

		// --- exit is clean ---
		expect(exitCode).toBe(0);

		// --- proof of INCREMENTAL (event-driven) delivery ---
		// If Bun buffered until exit, every line would carry an almost identical
		// timestamp clustered at the very end. With 100ms gaps the spread between
		// the first and last observed line must be clearly non-trivial.
		const firstAt = lines[0]?.at ?? 0;
		const lastAt = lines[N - 1]?.at ?? 0;
		const spread = lastAt - firstAt;
		expect(spread).toBeGreaterThan(150); // >= ~4 * 100ms sleeps, allow slack

		// The first line must arrive well before the process exits — i.e. we
		// observed output mid-flight, not in a post-exit dump.
		expect(firstAt).toBeLessThan(exitAt - 100);

		// --- exit detected promptly after the last line (< 500ms) ---
		const exitAfterLastLine = exitAt - lastAt;
		expect(exitAfterLastLine).toBeLessThan(500);
	});

	it("detects a non-zero exit code", async () => {
		const { lines, exitCode } = await collectLinesIncrementally([
			"bash",
			"-c",
			"echo only_line; exit 3",
		]);

		expect(lines).toHaveLength(1);
		expect(lines[0]?.text).toBe("only_line");
		expect(exitCode).toBe(3);
	});

	it("delivers a steady stream incrementally, each line strictly after the previous", async () => {
		// Stronger ordering guarantee: arrival timestamps are monotonic and each
		// successive line lands meaningfully later than the one before, which is
		// only possible if chunks are surfaced during the child's lifetime.
		const { lines } = await collectLinesIncrementally([
			"bash",
			"-c",
			"for i in 1 2 3; do echo evt_$i; sleep 0.12; done",
		]);

		expect(lines).toHaveLength(3);
		expect(lines.map((l) => l.text)).toEqual(["evt_1", "evt_2", "evt_3"]);

		for (let i = 1; i < lines.length; i++) {
			const gap = (lines[i]?.at ?? 0) - (lines[i - 1]?.at ?? 0);
			// At least one inter-line gap proves we did not receive a single dump.
			expect(gap).toBeGreaterThan(50);
		}
	});
});
