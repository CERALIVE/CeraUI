import type { LogEntry, LogLevel } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { sourceOfUnit } from "./catalog.ts";

export type RawJournalRecord = LogEntry & {
	readonly messageId: string | null;
	readonly unitField: string | null;
	readonly pid: number | null;
	readonly eventId?: string;
};

const objectSchema = z.record(z.string(), z.unknown());
const eventMetaSchema = z.object({ event_id: z.string().min(1) });
const MESSAGE_BYTES = 16 * 1024;
// Only the export projection reads pre-cut text. It must never enter the RPC entry.
const preCut = new WeakMap<
	RawJournalRecord,
	{ readonly unit: string | undefined; readonly message: string | undefined }
>();
const LEGACY_LEVELS: Readonly<Record<string, LogLevel>> = {
	error: "error",
	warn: "warning",
	info: "info",
	debug: "debug",
};
const stringField = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

export function parseRecord(input: unknown): RawJournalRecord | null {
	const parsed = objectSchema.safeParse(input);
	if (!parsed.success) return null;
	const obj = parsed.data;
	const cursor = stringField(obj.__CURSOR);
	const rawTime = obj.__REALTIME_TIMESTAMP;
	const micros =
		typeof rawTime === "number" ||
		(typeof rawTime === "string" && /^\d+$/.test(rawTime))
			? Number(rawTime)
			: NaN;
	const bootId = stringField(obj._BOOT_ID);
	if (
		!cursor ||
		!Number.isSafeInteger(micros) ||
		micros < 0 ||
		!bootId ||
		!/^[0-9a-f]{32}$/.test(bootId)
	)
		return null;
	// Cursors own ordering; flooring journal microseconds cannot reorder entries.
	const ts = Math.floor(micros / 1000);
	const priority =
		typeof obj.PRIORITY === "string" || typeof obj.PRIORITY === "number"
			? String(obj.PRIORITY)
			: "";
	let level: LogLevel = /^[0-3]$/.test(priority)
		? "error"
		: priority === "4"
			? "warning"
			: priority === "7"
				? "debug"
				: "info";
	const systemUnit = stringField(obj._SYSTEMD_UNIT);
	const identifier = stringField(obj.SYSLOG_IDENTIFIER);
	const unit =
		(systemUnit?.endsWith(".service")
			? stringField(systemUnit.slice(0, -".service".length))
			: null) ??
		identifier ??
		"system";
	let message: string | undefined;
	if (typeof obj.MESSAGE === "string") message = obj.MESSAGE;
	else if (Array.isArray(obj.MESSAGE)) {
		if (obj.MESSAGE.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))
			message = new TextDecoder().decode(Uint8Array.from(obj.MESSAGE));
		else message = obj.MESSAGE.find((v): v is string => typeof v === "string");
	}
	let truncated = message === undefined;
	let text = message ?? "";
	let processSource: "srtla_send" | undefined;
	let eventId: string | undefined;
	if (text.startsWith('{"ts":')) {
		try {
			const structured = objectSchema.safeParse(JSON.parse(text));
			if (structured.success && typeof structured.data.msg === "string") {
				const data = structured.data;
				if (data.processSource === "srtla_send")
					processSource = data.processSource;
				if (data.module === "events" && data.msg === "event") {
					const meta = eventMetaSchema.safeParse(data.meta);
					if (meta.success) eventId = meta.data.event_id;
				}
				text = `${typeof data.module === "string" && data.module ? `[${data.module}] ` : ""}${data.msg}${
					data.meta !== null && typeof data.meta === "object"
						? ` ${JSON.stringify(data.meta)}`
						: ""
				}`;
				if (
					typeof data.level === "string" &&
					Object.hasOwn(LEGACY_LEVELS, data.level)
				)
					level = LEGACY_LEVELS[data.level] ?? level;
			}
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
	}
	const clipped = clipJournalMessage(text);
	truncated ||= clipped !== text;
	const messageId = stringField(obj.MESSAGE_ID);
	const rawPid = obj._PID;
	const pid =
		typeof rawPid === "string" && /^\d+$/.test(rawPid) ? Number(rawPid) : NaN;
	const record: RawJournalRecord = {
		cursor,
		ts,
		bootId,
		level,
		unit,
		source:
			obj._TRANSPORT === "kernel"
				? "kernel"
				: sourceOfUnit(
						systemUnit ?? identifier ?? "",
						systemUnit ? processSource : undefined,
					),
		message: clipped,
		truncated,
		marker:
			messageId === "a596d6fe7bfa4994828e72309e95d61e" ? "suppressed" : null,
		messageId,
		unitField: stringField(obj.UNIT),
		pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
		...(eventId === undefined ? {} : { eventId }),
	};
	const rawUnit = systemUnit === `${unit}.service` ? systemUnit : undefined;
	if (rawUnit || clipped !== text)
		preCut.set(record, {
			unit: rawUnit,
			message: clipped === text ? undefined : text,
		});
	return record;
}

export function clipJournalMessage(text: string): string {
	const bytes = new TextEncoder().encode(text);
	return bytes.byteLength <= MESSAGE_BYTES
		? text
		: new TextDecoder().decode(bytes.subarray(0, MESSAGE_BYTES), {
				stream: true,
			});
}

export function journalTextBeforeCut(record: RawJournalRecord) {
	return preCut.get(record);
}

export function toLogEntry(record: RawJournalRecord): LogEntry {
	const {
		messageId: _messageId,
		unitField: _unitField,
		pid: _pid,
		eventId: _eventId,
		...entry
	} = record;
	return entry;
}
