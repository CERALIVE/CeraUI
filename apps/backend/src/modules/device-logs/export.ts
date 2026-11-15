import {
	type LogExportInput,
	type LogExportOutput,
	logExportInputSchema,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import { currentBootId } from "./boot-id.ts";
import type { ParsedQuery } from "./continuation.ts";
import { EXPORT_TIME_MS, exportChunks } from "./export-body.ts";
import { exportFilename } from "./export-format.ts";
import { getLogState } from "./settings.ts";
import { reserveLogSharing } from "./sharing.ts";

interface Ticket {
	readonly query: ParsedQuery;
	readonly bootId: string | null;
	readonly epoch: number;
	readonly expiresAt: number;
	readonly lease: NonNullable<ReturnType<typeof reserveLogSharing>>;
}
const tickets = new Map<string, Ticket>();
const active = new Map<AbortController, Promise<void>>();

export async function createExport(
	_conn: object,
	input: LogExportInput,
): Promise<LogExportOutput> {
	const parsed = logExportInputSchema.parse(input);
	const query = logQueryInputSchema.parse({
		...parsed.filter,
		boot: parsed.boot,
		since: parsed.since,
		until: parsed.until,
		direction: "older",
		limit: 200,
	});
	const bootId =
		query.boot === "all"
			? null
			: query.boot === "current"
				? currentBootId()
				: query.boot;
	if (bootId === undefined) return { ok: false, error: "BOOT_UNAVAILABLE" };
	const now = Date.now();
	for (const [key, value] of tickets) {
		if (value.expiresAt <= now) {
			tickets.delete(key);
			value.lease.release();
		}
	}
	const lease = reserveLogSharing(now);
	if (!lease) return { ok: false, error: "BUSY" };
	const ticket = Buffer.from(
		crypto.getRandomValues(new Uint8Array(32)),
	).toString("hex");
	const expiresAt = now + 60_000;
	tickets.set(ticket, {
		query,
		bootId,
		epoch: getLogState().historyEpoch,
		expiresAt,
		lease,
	});
	return { ok: true, url: `/api/logs/export?ticket=${ticket}`, expiresAt };
}

export async function handleLogExportRequest(
	request: Request,
): Promise<Response> {
	if (request.method !== "GET") return new Response(null, { status: 405 });
	const key = new URL(request.url).searchParams.get("ticket") ?? "";
	const ticket = tickets.get(key);
	tickets.delete(key);
	if (!ticket) return new Response(null, { status: 403 });
	if (ticket.expiresAt <= Date.now()) {
		ticket.lease.release();
		return new Response(null, { status: 403 });
	}
	ticket.lease.start();
	const controller = new AbortController();
	const done = Promise.withResolvers<void>();
	active.set(controller, done.promise);
	const signal = AbortSignal.any([request.signal, controller.signal]);
	const createdAt = Date.now();
	const iterator = exportChunks(
		ticket.query,
		ticket.bootId,
		ticket.epoch,
		signal,
		createdAt,
	);
	const timeout = setTimeout(
		() => controller.abort("time_limit"),
		EXPORT_TIME_MS,
	);
	let finished = false;
	let cancelled = false;
	let pending = Promise.resolve();
	const finish = () => {
		finished = true;
		signal.removeEventListener("abort", onAbort);
		clearTimeout(timeout);
		active.delete(controller);
		ticket.lease.release();
		done.resolve();
	};
	const pump = (sink: ReadableStreamDefaultController<Uint8Array>) => {
		pending = pending.then(async () => {
			if (finished) return;
			try {
				const chunk = await iterator.next();
				if (cancelled) return;
				if (chunk.done) {
					sink.close();
					finish();
				} else sink.enqueue(chunk.value);
			} catch (error) {
				finish();
				sink.error(error);
			}
		});
		return pending;
	};
	let sink: ReadableStreamDefaultController<Uint8Array>;
	const onAbort = () => {
		// Drive the footer and join a scan even when the client has stopped reading.
		void pump(sink).then(() => pump(sink));
	};
	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				sink = controller;
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			},
			pull: pump,
			async cancel() {
				cancelled = true;
				controller.abort();
				await pending;
				await iterator.return(undefined);
				finish();
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(stream, {
		headers: {
			"Content-Disposition": `attachment; filename="${exportFilename(ticket.bootId, createdAt)}"`,
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}

export async function abortLogExports(): Promise<void> {
	for (const ticket of tickets.values()) ticket.lease.release();
	tickets.clear();
	for (const controller of active.keys()) controller.abort("cleared");
	await Promise.all(active.values());
}
