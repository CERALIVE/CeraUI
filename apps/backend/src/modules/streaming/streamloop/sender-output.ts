import { logger } from "../../../helpers/logger.ts";
import { SENDER_LOG_PREFIX } from "../constants.ts";

const LINE_BYTES = 8 * 1024;
const LINES_PER_SECOND = 32;
const WINDOW_MS = 1000;
const TRACING_LEVELS = new Map<string, "debug" | "info" | "warn" | "error">([
	["TRACE", "debug"],
	["DEBUG", "debug"],
	["INFO", "info"],
	["WARN", "warn"],
	["ERROR", "error"],
] as const);
const senderMeta = { processSource: "srtla_send" } as const;
type OutputPipe = ReadableStream<Uint8Array>;

export async function captureSenderOutput(
	pipes: { readonly stdout: OutputPipe; readonly stderr: OutputPipe },
	errCallback: (data: string) => void,
): Promise<void> {
	let emitted = 0;
	let dropped = 0;
	let windowTimer: ReturnType<typeof setTimeout> | undefined;
	const closeWindow = () => {
		if (dropped > 0) {
			logger.warn(`${SENDER_LOG_PREFIX}output lines dropped`, {
				...senderMeta,
				dropped,
			});
		}
		emitted = 0;
		dropped = 0;
		windowTimer = undefined;
	};

	const logSenderLine = (text: string, clipped: boolean) => {
		const message = text.trimEnd();
		if (!message && !clipped) return;
		windowTimer ??= setTimeout(closeWindow, WINDOW_MS).unref();
		if (emitted >= LINES_PER_SECOND) {
			dropped++;
			return;
		}
		emitted++;
		const token = /^\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s/.exec(text)?.[1];
		const level =
			(token === undefined ? undefined : TRACING_LEVELS.get(token)) ??
			(/^(?:trace|debug)\b/i.test(message.trimStart())
				? "debug"
				: /\bwarn(?:ing)?\b/i.test(message)
					? "warn"
					: /\b(?:error|fatal|failed|cannot|could not|unable|panicked)\b/i.test(
								message,
							)
						? "error"
						: "info");
		logger[level](
			`${SENDER_LOG_PREFIX}${message}${clipped ? " [truncated]" : ""}`,
			senderMeta,
		);
	};

	const drain = async (pipe: OutputPipe, stream: "stdout" | "stderr") => {
		const tail = new Uint8Array(LINE_BYTES);
		const decoder = new TextDecoder();
		const rawDecoder = new TextDecoder();
		let used = 0;
		let clipped = false;
		try {
			for await (const chunk of pipe) {
				let start = 0;
				while (start < chunk.length) {
					const newline = chunk.indexOf(10, start);
					const end = newline < 0 ? chunk.length : newline;
					if (!clipped) {
						const retained = Math.min(end - start, tail.length - used);
						tail.set(chunk.subarray(start, start + retained), used);
						used += retained;
						clipped = retained < end - start;
						if (clipped) {
							// Streaming decode omits an incomplete UTF-8 character at the cap.
							logSenderLine(decoder.decode(tail, { stream: true }), true);
							decoder.decode();
						} else if (newline >= 0) {
							logSenderLine(decoder.decode(tail.subarray(0, used)), false);
						}
					}
					if (newline < 0) break;
					used = 0;
					clipped = false;
					start = newline + 1;
				}
				// Stdout traces can match the stderr notification rules. Keep
				// notification inputs on the original stderr chunk boundaries.
				if (stream === "stderr") errCallback(rawDecoder.decode(chunk));
			}
			if (used > 0 && !clipped)
				logSenderLine(decoder.decode(tail.subarray(0, used)), false);
		} catch (err) {
			// Killing the child can tear down its output pipes.
			logger.debug("srtla_send output drain ended", { stream, err });
		}
	};

	await Promise.all([
		drain(pipes.stdout, "stdout"),
		drain(pipes.stderr, "stderr"),
	]);
	clearTimeout(windowTimer);
	closeWindow();
}
