import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type DeviceEvent,
	deviceEventSchema,
	type EventBootRecord,
	eventBootRecordSchema,
} from "@ceraui/rpc/schemas";
import { z } from "zod";
import { logger } from "../../helpers/logger.ts";
import { isDevelopment } from "../../mocks/mock-config.ts";

const eventRecordSchema = deviceEventSchema.extend({
	bootId: eventBootRecordSchema.shape.bootId,
});
const EVENTS = {
	name: "events",
	bytes: 512 * 1024,
	files: 8,
	schema: eventRecordSchema,
} as const;
const BOOTS = {
	name: "boots",
	bytes: 128 * 1024,
	files: 2,
	schema: eventBootRecordSchema,
} as const;
type Ring = typeof EVENTS | typeof BOOTS;

export interface EventStoreDeps {
	readonly baseDir?: string;
	readonly fs?: Pick<
		typeof fs,
		| "mkdirSync"
		| "existsSync"
		| "statSync"
		| "readFileSync"
		| "readSync"
		| "chmodSync"
		| "rmSync"
		| "renameSync"
		| "openSync"
		| "fchmodSync"
		| "appendFileSync"
		| "fdatasyncSync"
		| "closeSync"
	>;
	readonly warn?: (message: string) => void;
}

export function resolveEventsDir(
	env: Record<string, string | undefined> = process.env,
	development: () => boolean = isDevelopment,
): string {
	const explicit = env.CERALIVE_EVENTS_DIR?.trim();
	if (explicit) return explicit;
	const data = env.CERALIVE_DATA_DIR?.trim();
	if (data) return path.join(data, "ceralive", "events");
	return development()
		? path.join(tmpdir(), "ceralive-dev", "events")
		: "/data/ceralive/events";
}

function filePath(base: string, ring: Ring, generation: number): string {
	return path.join(
		base,
		generation === 0
			? `${ring.name}.jsonl`
			: `${ring.name}.${generation}.jsonl`,
	);
}

function contain<T>(deps: EventStoreDeps, fallback: T, run: () => T): T {
	try {
		return run();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		(deps.warn ?? ((text) => logger.warn(text)))(
			`event store: operation failed: ${message}`,
		);
		return fallback;
	}
}

function append(
	record: DeviceEvent | EventBootRecord,
	ring: Ring,
	deps: EventStoreDeps & { readonly sync: boolean },
): void {
	contain(deps, undefined, () => {
		const parsed = ring.schema.safeParse(record);
		if (!parsed.success) throw new TypeError("invalid record");
		const io = deps.fs ?? fs;
		const base = deps.baseDir ?? resolveEventsDir();
		const line = `${JSON.stringify({ v: 1, ...parsed.data })}\n`;
		if (Buffer.byteLength(line) > ring.bytes) {
			throw new RangeError("record exceeds event store file limit");
		}
		io.mkdirSync(base, { recursive: true, mode: 0o700 });
		const file = filePath(base, ring, 0);
		let prefix = "";
		if (io.existsSync(file)) {
			const size = io.statSync(file).size;
			if (size > ring.bytes) {
				throw new RangeError("existing event store file exceeds limit");
			}
			// Separate a torn append from the next record after a process restart.
			if (size > 0) {
				const tail = new Uint8Array(1);
				const fd = io.openSync(file, "r");
				try {
					if (io.readSync(fd, tail, { length: 1, position: size - 1 }) !== 1)
						throw new RangeError("event store tail could not be read");
					if (tail[0] !== 10) prefix = "\n";
				} finally {
					io.closeSync(fd);
				}
			}
			io.chmodSync(file, 0o600);
			if (size + Buffer.byteLength(prefix + line) > ring.bytes) {
				io.rmSync(filePath(base, ring, ring.files - 1), { force: true });
				for (let gen = ring.files - 2; gen >= 0; gen -= 1) {
					const from = filePath(base, ring, gen);
					if (io.existsSync(from)) {
						io.renameSync(from, filePath(base, ring, gen + 1));
					}
				}
				prefix = "";
			}
		}
		const fd = io.openSync(file, "a", 0o600);
		try {
			io.fchmodSync(fd, 0o600);
			io.appendFileSync(fd, prefix + line);
			if (deps.sync) io.fdatasyncSync(fd);
		} finally {
			io.closeSync(fd);
		}
	});
}

export function appendEvent(
	event: DeviceEvent,
	options: EventStoreDeps & { readonly sync: boolean },
): void {
	append(event, EVENTS, options);
}

export function appendBoot(
	record: EventBootRecord,
	deps: EventStoreDeps = {},
): void {
	append(record, BOOTS, { ...deps, sync: true });
}

const storedEventSchema = eventRecordSchema.extend({ v: z.literal(1) });
const storedBootSchema = eventBootRecordSchema.extend({ v: z.literal(1) });

function read<T extends { v: number }>(
	ring: Ring,
	schema: z.ZodType<T>,
	deps: EventStoreDeps,
): Omit<T, "v">[] {
	return contain(deps, [], () => {
		const io = deps.fs ?? fs;
		const base = deps.baseDir ?? resolveEventsDir();
		const records: Omit<T, "v">[] = [];
		for (let gen = ring.files - 1; gen >= 0; gen -= 1) {
			const file = filePath(base, ring, gen);
			if (!io.existsSync(file)) continue;
			if (io.statSync(file).size > ring.bytes) continue;
			const text = io.readFileSync(file, "utf8");
			// Only newline-terminated records committed by the writer are complete.
			for (const line of text.split("\n").slice(0, -1)) {
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch (error) {
					if (error instanceof SyntaxError) continue;
					throw error;
				}
				const parsed = schema.safeParse(value);
				if (parsed.success) {
					const { v: _version, ...record } = parsed.data;
					records.push(record);
				}
			}
		}
		return records;
	});
}

export function readEvents(deps: EventStoreDeps = {}): DeviceEvent[] {
	return read(EVENTS, storedEventSchema, deps);
}

export function readBoots(deps: EventStoreDeps = {}): EventBootRecord[] {
	return read(BOOTS, storedBootSchema, deps);
}

export function tailSeq(deps: EventStoreDeps = {}): number {
	const events = readEvents(deps);
	return events.reduce(
		(max, event) => Math.max(max, event.seq),
		events[0]?.seq ?? 0,
	);
}

export function clearEvents(deps: EventStoreDeps = {}): boolean {
	return contain(deps, false, () => {
		const io = deps.fs ?? fs;
		const base = deps.baseDir ?? resolveEventsDir();
		let failure: { readonly error: unknown } | undefined;
		for (let gen = 0; gen < EVENTS.files; gen += 1) {
			try {
				io.rmSync(filePath(base, EVENTS, gen), { force: true });
			} catch (error) {
				failure ??= { error };
			}
		}
		if (failure) throw failure.error;
		return true;
	});
}

export function eventsBytes(deps: EventStoreDeps = {}): number {
	return contain(deps, 0, () => {
		const io = deps.fs ?? fs;
		const base = deps.baseDir ?? resolveEventsDir();
		let bytes = 0;
		for (let gen = 0; gen < EVENTS.files; gen += 1) {
			const file = filePath(base, EVENTS, gen);
			if (io.existsSync(file)) bytes += io.statSync(file).size;
		}
		return bytes;
	});
}
