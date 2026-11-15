import { clearTimeout, setTimeout } from "node:timers";
import {
	EVENT_REGISTRY,
	type EventCode,
	type EventParams,
} from "@ceraui/rpc/events";
import { logger, logRedact } from "../../helpers/logger.ts";
import { currentBootId } from "../device-logs/boot-id.ts";
import { appendEvent, readEvents, tailSeq } from "./store.ts";

type DeviceEvent = Parameters<typeof appendEvent>[0];
interface EventTimer {
	unref(): unknown;
	cancel(): void;
}
export interface EventEmitterDeps {
	readonly now: () => number;
	readonly bootId: typeof currentBootId;
	readonly tailSeq: () => number;
	readonly appendEvent: typeof appendEvent;
	readonly readEvents: typeof readEvents;
	readonly log: (
		level: string,
		message: string,
		meta: Record<string, unknown>,
	) => void;
	readonly warn: (message: string, meta: Record<string, unknown>) => void;
	readonly schedule: (fn: () => void, ms: number) => EventTimer;
}

function defaultDeps(): EventEmitterDeps {
	return {
		now: Date.now,
		bootId: currentBootId,
		tailSeq,
		appendEvent,
		readEvents,
		log: (level, message, meta) => {
			logger.log(level, message, meta);
		},
		warn: (message, meta) => {
			logger.warn(message, meta);
		},
		schedule: (fn, ms) => {
			const timer = setTimeout(fn, ms);
			return {
				unref: () => timer.unref(),
				cancel: () => clearTimeout(timer),
			};
		},
	};
}

type Pending = Pick<
	DeviceEvent,
	"code" | "family" | "severity" | "params" | "bootId"
>;
interface Window {
	readonly until: number;
	timer?: EventTimer;
	latest?: Pending;
	suppressed: number;
}

const WINDOW_MS = 30_000;
// shortcut: cap each subject collection at 1024 and drop new identities when full; revisit if device topology needs more.
const MAX_SUBJECTS = 1024;
let deps = defaultDeps();
let sink: ((event: DeviceEvent) => void) | null = null;
let seq: number | undefined;
let boot: string | undefined;
let lastSync: number | undefined;
const windows = new Map<string, Window>();
const updates = new Set<string>();
let updatesSeeded = false;

function warn(message: string, code?: EventCode): void {
	try {
		deps.warn(message, {
			module: "events",
			...(code === undefined ? {} : { code }),
		});
	} catch {
		// Diagnostics cannot turn an event into a control-path failure.
	}
}

function attempt(run: () => void): void {
	try {
		run();
	} catch {
		warn("event emission failed");
	}
}

function clearCoalescing(): void {
	for (const window of windows.values()) {
		if (window.timer) attempt(() => window.timer?.cancel());
	}
	windows.clear();
	updates.clear();
	updatesSeeded = false;
}

function publish(pending: Pending, at: number, suppressed?: number): void {
	seq ??= deps.tailSeq();
	const event: DeviceEvent = {
		...pending,
		id: `${pending.bootId.slice(0, 8)}-${++seq}`,
		seq,
		at,
		// logRedact preserves the registry's flat value types.
		params: logRedact(pending.params) as DeviceEvent["params"],
		...(suppressed === undefined ? {} : { suppressed }),
	};
	const alwaysSync =
		event.code === "shutdown_requested" || event.code === "service_stopping";
	const qualifies =
		alwaysSync ||
		event.code === "device_started" ||
		event.severity === "error" ||
		event.severity === "warning";
	const sync =
		qualifies &&
		(alwaysSync || lastSync === undefined || at - lastSync >= 1000);
	if (sync) lastSync = at;
	attempt(() => deps.appendEvent(event, { sync }));
	const level =
		event.severity === "error"
			? "error"
			: event.severity === "warning"
				? "warn"
				: "info";
	attempt(() =>
		deps.log(level, "event", {
			module: "events",
			event_id: event.id,
			code: event.code,
			params: event.params,
		}),
	);
	attempt(() => sink?.(event));
}

function closeWindow(subject: string, window: Window): void {
	if (windows.get(subject) !== window) return;
	windows.delete(subject);
	if (window.timer) attempt(() => window.timer?.cancel());
	if (window.latest) publish(window.latest, deps.now(), window.suppressed);
}

export function emitEvent<C extends EventCode>(
	code: C,
	params: EventParams<C>,
): void {
	attempt(() => {
		const definition = EVENT_REGISTRY[code];
		const parsed = definition.params.safeParse(params);
		if (!parsed.success) {
			warn("invalid event params", code);
			return;
		}
		const bootId = deps.bootId();
		if (bootId === undefined) return;
		if (boot !== bootId) {
			clearCoalescing();
			boot = bootId;
			lastSync = undefined;
		}
		const subject = definition.subject(parsed.data);
		const pending: Pending = {
			code,
			family: definition.family,
			severity: definition.severity(parsed.data),
			params: Object.fromEntries(
				Object.entries(parsed.data).filter(([, value]) => value !== undefined),
			),
			bootId,
		};
		const at = deps.now();
		if (definition.family === "update") {
			if (!updatesSeeded) {
				updatesSeeded = true;
				try {
					const registry = new Map(Object.entries(EVENT_REGISTRY));
					for (const event of deps.readEvents()) {
						const storedDefinition = registry.get(event.code);
						if (
							event.bootId !== bootId ||
							storedDefinition?.family !== "update"
						)
							continue;
						updates.add(storedDefinition.subject(event.params));
						if (updates.size >= MAX_SUBJECTS) break;
					}
				} catch {
					updates.clear();
					warn("event update seed failed");
				}
			}
			if (updates.has(subject) || updates.size >= MAX_SUBJECTS) return;
			updates.add(subject);
		} else {
			let window = windows.get(subject);
			if (window && at >= window.until) {
				closeWindow(subject, window);
				window = windows.get(subject);
			}
			if (window) {
				window.latest = pending;
				window.suppressed++;
				return;
			}
			if (windows.size >= MAX_SUBJECTS) return;
			const opened: Window = { until: at + WINDOW_MS, suppressed: 0 };
			windows.set(subject, opened);
			try {
				opened.timer = deps.schedule(
					() => attempt(() => closeWindow(subject, opened)),
					WINDOW_MS,
				);
				opened.timer.unref();
			} catch {
				windows.delete(subject);
				if (opened.timer) attempt(() => opened.timer?.cancel());
				warn("event scheduling failed");
				return;
			}
		}
		publish(pending, at);
	});
}

export function setEventSink(fn: ((event: DeviceEvent) => void) | null): void {
	sink = fn;
}

export function resetEventEmitterForTest(
	overrides: Partial<EventEmitterDeps> = {},
): void {
	clearCoalescing();
	deps = { ...defaultDeps(), ...overrides };
	sink = null;
	seq = undefined;
	boot = undefined;
	lastSync = undefined;
}
