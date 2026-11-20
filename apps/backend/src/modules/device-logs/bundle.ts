import type { LogBundleManifest, LogExportOutput } from "@ceraui/rpc/schemas";
import { BUNDLE_TIME_MS, buildBundle } from "./bundle-body.ts";
import { BundleReadError } from "./redaction.ts";
import { getLogState } from "./settings.ts";
import { reserveLogSharing } from "./sharing.ts";
import { withHistoryAdmission } from "./sharing-admission.ts";

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
	conn: object,
	signal?: AbortSignal,
): Promise<LogExportOutput>;
async function prepare(
	conn: null,
	signal?: AbortSignal,
): Promise<PreviewResult>;
async function prepare(
	conn: object | null,
	signal?: AbortSignal,
): Promise<LogExportOutput | PreviewResult> {
	const now = Date.now();
	const controller = new AbortController();
	const combined = AbortSignal.any(
		signal ? [signal, controller.signal] : [controller.signal],
	);
	const timer = setTimeout(
		() => controller.abort("time_limit"),
		BUNDLE_TIME_MS,
	);
	try {
		return (
			(await withHistoryAdmission(combined, (epoch) =>
				collectAndIssue(conn, { signal: combined, now, epoch }, controller),
			)) ?? { ok: false, error: "READ_FAILED" }
		);
	} catch {
		// This boundary never propagates exceptions, causes, or abort reasons.
		return { ok: false, error: "READ_FAILED" };
	} finally {
		clearTimeout(timer);
	}
}

async function collectAndIssue(
	conn: object | null,
	{ signal, now, epoch }: BundleWindow,
	controller: AbortController,
): Promise<LogExportOutput | PreviewResult> {
	const lease = reserveLogSharing(conn);
	if (!lease) return { ok: false, error: "BUSY" } as const;
	const done = Promise.withResolvers<void>();
	active.set(controller, done.promise);
	try {
		const body = await buildBundle(
			{ signal, createdAt: now, epoch },
			conn !== null,
		);
		if (
			(signal.aborted && signal.reason !== "time_limit") ||
			getLogState().historyEpoch !== epoch
		)
			throw new BundleReadError();
		if (conn === null) {
			lease.release();
			return { ok: true, manifest: body.manifest };
		}
		const key = Buffer.from(
			crypto.getRandomValues(new Uint8Array(32)),
		).toString("hex");
		const expiresAt = Date.now() + 60_000;
		tickets.set(key, { body, lease, expiresAt, epoch });
		lease.issue(expiresAt, () => tickets.delete(key));
		return { ok: true, url: `/api/logs/bundle?ticket=${key}`, expiresAt };
	} catch {
		lease.release();
		throw new BundleReadError();
	} finally {
		active.delete(controller);
		done.resolve();
	}
}

type BundleWindow = {
	readonly signal: AbortSignal;
	readonly now: number;
	readonly epoch: number;
};

export async function previewBundle(
	signal?: AbortSignal,
): Promise<LogBundleManifest> {
	const result = await prepare(null, signal);
	if (!result.ok) throw new BundleReadError(result.error);
	return result.manifest;
}

export async function createBundle(
	conn: object,
	signal?: AbortSignal,
): Promise<LogExportOutput> {
	return prepare(conn, signal);
}

export async function handleLogBundleRequest(
	request: Request,
): Promise<Response> {
	if (request.method !== "GET") return new Response(null, { status: 405 });
	const key = new URL(request.url).searchParams.get("ticket") ?? "";
	const controller = new AbortController();
	const signal = AbortSignal.any([request.signal, controller.signal]);
	const timeout = setTimeout(
		() => controller.abort("time_limit"),
		BUNDLE_TIME_MS,
	);
	let response: Response | undefined;
	try {
		response = await withHistoryAdmission(signal, (epoch) => {
			const ticket = tickets.get(key);
			tickets.delete(key);
			if (!ticket) return new Response(null, { status: 403 });
			if (ticket.expiresAt <= Date.now()) {
				ticket.lease.release();
				return new Response(null, { status: 403 });
			}
			if (ticket.epoch !== epoch) {
				ticket.lease.release();
				return new Response(null, { status: 409 });
			}
			return streamTicket(ticket, { controller, signal, timeout });
		});
		return (
			response ?? new Response(null, { status: tickets.has(key) ? 409 : 403 })
		);
	} catch {
		return new Response(null, { status: 500 });
	} finally {
		if (!response?.ok) clearTimeout(timeout);
		if (!response) {
			tickets.get(key)?.lease.release();
			tickets.delete(key);
		}
	}
}

function streamTicket(
	ticket: Ticket,
	{
		controller,
		signal,
		timeout,
	}: {
		readonly controller: AbortController;
		readonly signal: AbortSignal;
		readonly timeout: ReturnType<typeof setTimeout>;
	},
): Response {
	ticket.lease.stream();
	const done = Promise.withResolvers<void>();
	active.set(controller, done.promise);
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
