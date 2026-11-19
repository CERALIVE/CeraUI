import {
	type LogExportInput,
	type LogExportOutput,
	logExportInputSchema,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import { currentBootId } from "./boot-id.ts";
import { abortLogBundles } from "./bundle.ts";
import type { ParsedQuery } from "./continuation.ts";
import {
	EXPORT_TIME_MS,
	exportAbortReason,
	exportChunks,
} from "./export-body.ts";
import { exportFilename } from "./export-format.ts";
import { getLogState } from "./settings.ts";
import { reserveLogSharing } from "./sharing.ts";
import { withHistoryAdmission } from "./sharing-admission.ts";

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
	signal?: AbortSignal,
): Promise<LogExportOutput> {
	const parsed = logExportInputSchema.parse(input);
	return (
		(await withHistoryAdmission(signal, (epoch) =>
			issueTicket(parsed, epoch),
		)) ?? { ok: false, error: "READ_FAILED" }
	);
}

function issueTicket(parsed: LogExportInput, epoch: number): LogExportOutput {
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
		epoch,
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
	const response = await withHistoryAdmission(request.signal, (epoch) =>
		redeemTicket(request.signal, key, epoch),
	);
	if (response) return response;
	if (request.signal.aborted) {
		const ticket = takeTicket(key);
		if (ticket)
			return interruptedExport(
				ticket,
				ticket.epoch !== getLogState().historyEpoch
					? "cleared"
					: exportAbortReason(request.signal),
			);
	}
	return new Response(null, { status: 403 });
}

function takeTicket(key: string): Ticket | undefined {
	const ticket = tickets.get(key);
	tickets.delete(key);
	if (ticket && ticket.expiresAt <= Date.now()) {
		ticket.lease.release();
		return;
	}
	return ticket;
}

function interruptedExport(ticket: Ticket, reason: string): Response {
	ticket.lease.release();
	return new Response(`# incomplete: ${reason}\n`, {
		headers: exportHeaders(ticket, Date.now()),
	});
}

function exportHeaders(ticket: Ticket, createdAt: number) {
	return {
		"Content-Disposition": `attachment; filename="${exportFilename(ticket.bootId, createdAt)}"`,
		"Cache-Control": "no-store",
		"Content-Type": "text/plain; charset=utf-8",
	};
}

function redeemTicket(
	requestSignal: AbortSignal,
	key: string,
	epoch: number,
): Response {
	const ticket = takeTicket(key);
	if (!ticket) return new Response(null, { status: 403 });
	if (ticket.epoch !== epoch) return interruptedExport(ticket, "cleared");
	ticket.lease.start();
	const controller = new AbortController();
	const done = Promise.withResolvers<void>();
	active.set(controller, done.promise);
	const signal = AbortSignal.any([requestSignal, controller.signal]);
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
		if (finished) return;
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
	return new Response(stream, { headers: exportHeaders(ticket, createdAt) });
}

export async function abortLogExports(): Promise<void> {
	const bundles = abortLogBundles();
	for (const ticket of tickets.values()) ticket.lease.release();
	tickets.clear();
	for (const controller of active.keys()) controller.abort("cleared");
	await Promise.all([bundles, ...active.values()]);
}
