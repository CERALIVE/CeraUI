import {
	type LogEntry,
	type LogQueryOutput,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import type { ParsedQuery } from "./continuation.ts";
import { withQuerySlot } from "./query-admission.ts";
import { BundleReadError } from "./redaction.ts";
import { scanPage } from "./scan-page.ts";

type TimeLimit = "time_limit";
type AppendCut = "size_limit" | "compressed_size_limit";
type Cut =
	| TimeLimit
	| AppendCut
	| Extract<LogQueryOutput, { ok: false }>["error"];
type BootWindow = {
	readonly signal: AbortSignal;
	readonly stopped: () => TimeLimit | null;
};

export async function collectBundleJournal(
	[current, previous]: readonly string[],
	window: BootWindow & { readonly epoch: number; readonly deadline: number },
	append: (entry: LogEntry, isCurrent: boolean) => Promise<AppendCut | null>,
): Promise<{ readonly bootsCovered: number; readonly incomplete: Cut | null }> {
	const owner = {};
	const queryFor = (boot: string) =>
		logQueryInputSchema.parse({ boot, direction: "older", limit: 200 });
	async function read(position: ParsedQuery, boot: string, phase: BootWindow) {
		try {
			return await withQuerySlot(
				owner,
				(slotSignal) =>
					scanPage(position, {
						bootId: boot,
						epoch: window.epoch,
						signal: AbortSignal.any([phase.signal, slotSignal]),
					}),
				phase.signal,
			);
		} catch (error) {
			if (error instanceof BundleReadError) throw error;
			return { ok: false, error: "READ_FAILED" } as const;
		}
	}

	let bootsCovered = 0;
	async function walk(
		boot: string,
		phase: BootWindow,
		firstPage?: LogQueryOutput,
	): Promise<Cut | null> {
		const isCurrent = boot === current;
		let covered = false;
		let position = queryFor(boot);
		let page = firstPage;
		for (;;) {
			const beforeRead = phase.stopped();
			if (beforeRead) return beforeRead;
			page ??= await read(position, boot, phase);
			const afterRead = phase.stopped();
			if (afterRead) return afterRead;
			if (!page.ok) return page.error;
			try {
				for (const entry of page.entries) {
					const cut = phase.stopped() ?? (await append(entry, isCurrent));
					if (cut) return cut;
					if (!covered) {
						covered = true;
						bootsCovered++;
					}
				}
			} catch (error) {
				if (error instanceof BundleReadError) throw error;
				return phase.stopped() ?? "READ_FAILED";
			}
			if (page.hasMore === false) return null;
			if (
				page.continuation === null ||
				(page.termination === "budget" &&
					page.continuation === position.continuation)
			)
				return "READ_FAILED";
			position = { ...position, continuation: page.continuation };
			page = undefined;
		}
	}

	let incomplete: Cut | null = window.stopped();
	if (current === undefined || incomplete) return { bootsCovered, incomplete };
	if (previous === undefined)
		return { incomplete: await walk(current, window), bootsCovered };

	// Read one running-boot page before sharing the remaining time. Write
	// previous records first so their byte cap and output order are unchanged.
	const head = await read(queryFor(current), current, window);
	const now = Date.now();
	const remaining = window.deadline - now;
	if (remaining > 0 && !window.stopped()) {
		const previousTime = Math.floor(remaining / 2);
		const previousDeadline = now + previousTime;
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), previousTime);
		try {
			incomplete = await walk(previous, {
				signal: AbortSignal.any([window.signal, timeout.signal]),
				stopped: () =>
					window.stopped() ??
					(timeout.signal.aborted || Date.now() >= previousDeadline
						? "time_limit"
						: null),
			});
		} finally {
			clearTimeout(timer);
		}
	}
	const currentCut = await walk(current, window, head);
	return { bootsCovered, incomplete: incomplete ?? currentCut };
}
