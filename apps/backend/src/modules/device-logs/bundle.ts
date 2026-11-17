import type { LogBundleManifest, LogExportOutput } from "@ceraui/rpc/schemas";
import { buildBundle } from "./bundle-body.ts";
import { BundleReadError } from "./redaction.ts";
import { getLogState } from "./settings.ts";
import { reserveLogSharing } from "./sharing.ts";

type Prepared = Awaited<ReturnType<typeof buildBundle>>;
type Lease = NonNullable<ReturnType<typeof reserveLogSharing>>;
interface Ticket {
	readonly body: Prepared;
	readonly lease: Lease;
	readonly expiresAt: number;
	readonly epoch: number;
}
const tickets = new Map<string, Ticket>();
const active = new Map<AbortController, Promise<void>>();

type PreparationFailure = {
	readonly ok: false;
	readonly error: "BUSY" | "READ_FAILED";
};
type PreviewResult =
	| { readonly ok: true; readonly manifest: LogBundleManifest }
	| PreparationFailure;
async function prepare(
	keep: true,
	signal?: AbortSignal,
): Promise<LogExportOutput>;
async function prepare(
	keep: false,
	signal?: AbortSignal,
): Promise<PreviewResult>;
async function prepare(
	keep: boolean,
	signal?: AbortSignal,
): Promise<LogExportOutput | PreviewResult> {
	const now = Date.now();
	for (const [key, ticket] of tickets) {
		if (ticket.expiresAt <= now) {
			tickets.delete(key);
			ticket.lease.release();
		}
	}
	const lease = reserveLogSharing(now);
	if (!lease) return { ok: false, error: "BUSY" } as const;
	lease.start();
	const controller = new AbortController();
	const done = Promise.withResolvers<void>();
	active.set(controller, done.promise);
	const combined = AbortSignal.any(
		signal ? [signal, controller.signal] : [controller.signal],
	);
	const timer = setTimeout(() => controller.abort("time_limit"), 60_000);
	try {
		if (combined.aborted) throw new BundleReadError();
		const epoch = getLogState().historyEpoch;
		const body = await buildBundle(combined, now, epoch, keep);
		if (
			(combined.aborted && combined.reason !== "time_limit") ||
			getLogState().historyEpoch !== epoch
		)
			throw new BundleReadError();
		if (!keep) {
			lease.release();
			return { ok: true, manifest: body.manifest };
		}
		const key = Buffer.from(
			crypto.getRandomValues(new Uint8Array(32)),
		).toString("hex");
		const expiresAt = Date.now() + 60_000;
		lease.start(expiresAt);
		tickets.set(key, { body, lease, expiresAt, epoch });
		return { ok: true, url: `/api/logs/bundle?ticket=${key}`, expiresAt };
	} catch {
		// This boundary never propagates exceptions, causes, or abort reasons.
		lease.release();
		return { ok: false, error: "READ_FAILED" } as const;
	} finally {
		clearTimeout(timer);
		active.delete(controller);
		done.resolve();
	}
}

export async function previewBundle(
	signal?: AbortSignal,
): Promise<LogBundleManifest> {
	const result = await prepare(false, signal);
	if (!result.ok) throw new BundleReadError(result.error);
	return result.manifest;
}

export async function createBundle(
	_conn: object,
	signal?: AbortSignal,
): Promise<LogExportOutput> {
	return prepare(true, signal);
}

export async function handleLogBundleRequest(
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
	let epoch: number;
	try {
		epoch = getLogState().historyEpoch;
	} catch {
		ticket.lease.release();
		return new Response(null, { status: 500 });
	}
	if (ticket.epoch !== epoch || request.signal.aborted) {
		ticket.lease.release();
		return new Response(null, { status: 409 });
	}
	ticket.lease.start();
	const controller = new AbortController();
	const done = Promise.withResolvers<void>();
	active.set(controller, done.promise);
	const signal = AbortSignal.any([request.signal, controller.signal]);
	const timeout = setTimeout(() => controller.abort("time_limit"), 60_000);
	let sink: ReadableStreamDefaultController<Uint8Array>;
	let position = 0;
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
		active.delete(controller);
		ticket.lease.release();
		done.resolve();
	};
	const fail = () => {
		finish();
		try {
			sink.error(new BundleReadError());
		} catch {
			/* The stream's consumer has already failed; ownership is released. */
		}
	};
	const onAbort = () => {
		if (finished) return;
		if (signal.reason === "time_limit") {
			fail();
			return;
		}
		finish();
		try {
			sink.close();
		} catch {
			fail();
		}
	};
	const stream = new ReadableStream<Uint8Array>(
		{
			start(value) {
				sink = value;
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			},
			pull(value) {
				if (finished) return;
				try {
					const chunk = ticket.body.chunks[position++];
					if (chunk === undefined) {
						finish();
						value.close();
					} else value.enqueue(chunk);
				} catch {
					fail();
				}
			},
			cancel() {
				finish();
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(stream, {
		headers: {
			"Content-Disposition": `attachment; filename="${ticket.body.filename}"`,
			"Content-Type": "application/gzip",
			"Cache-Control": "no-store",
		},
	});
}

export async function abortLogBundles(): Promise<void> {
	for (const ticket of tickets.values()) ticket.lease.release();
	tickets.clear();
	for (const controller of active.keys()) controller.abort();
	await Promise.all(active.values());
}
