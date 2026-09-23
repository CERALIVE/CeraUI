import type { CaptureStatus } from "@ceralive/cerastream";
import type { StreamSource } from "@ceraui/rpc/schemas";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { getSourcesMessage } from "./sources.ts";

export const CAPTURE_STANDBY_LONG_NOTICE_MS = 600_000;

export interface CaptureResilienceDeps {
	readonly sources: () => readonly StreamSource[];
	readonly notify: typeof notificationBroadcast;
	readonly removeNotification: (name: string) => void;
	readonly now: () => number;
	readonly setTimer: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout> | number;
	readonly clearTimer: (timer: ReturnType<typeof setTimeout> | number) => void;
}

function defaultDeps(): CaptureResilienceDeps {
	return {
		sources: () => getSourcesMessage().sources,
		notify: notificationBroadcast,
		removeNotification: notificationRemove,
		now: Date.now,
		setTimer: (callback, delayMs) => {
			const timer = setTimeout(callback, delayMs);
			timer.unref?.();
			return timer;
		},
		clearTimer: clearTimeout,
	};
}

let deps: CaptureResilienceDeps = defaultDeps();
const standing = new Set<string>();
let standbySince: number | undefined;
let standbyTimer: ReturnType<typeof setTimeout> | number | undefined;

function retract(name: string): void {
	if (!standing.delete(name)) return;
	deps.removeNotification(name);
}

function raise(
	name: string,
	message: string,
	key: string,
	params?: Record<string, unknown>,
): void {
	if (standing.has(name)) return;
	standing.add(name);
	deps.notify(name, "warning", message, 0, true, true, true, key, params);
}

function clearStandbyTimer(): void {
	if (standbyTimer !== undefined) deps.clearTimer(standbyTimer);
	standbyTimer = undefined;
}

function retractAll(): void {
	clearStandbyTimer();
	standbySince = undefined;
	for (const name of [...standing]) retract(name);
}

export function setCaptureResilienceDepsForTest(
	next: CaptureResilienceDeps | null,
): void {
	retractAll();
	deps = next ?? defaultDeps();
}

function nameFor(
	id: string,
	sources: readonly StreamSource[],
): string | undefined {
	const matches = sources.filter(
		(row) =>
			row.origin === "capture" &&
			(row.id === id || row.previousIds?.includes(id)),
	);
	const match = matches[0];
	return matches.length === 1 && match?.origin === "capture"
		? match.displayName
		: undefined;
}

function longStandby(): void {
	standbyTimer = undefined;
	if (standbySince === undefined) return;
	const remaining =
		CAPTURE_STANDBY_LONG_NOTICE_MS - (deps.now() - standbySince);
	if (remaining > 0) {
		standbyTimer = deps.setTimer(longStandby, remaining);
		return;
	}
	raise(
		"capture-standby-long",
		"The stream has been on standby for over 10 minutes. It will resume when a camera returns.",
		"notifications.captureStandbyLong",
	);
}

/** An absent capture block in a live partial frame is not recovery evidence. */
export function noteCaptureStatus(
	capture: CaptureStatus | undefined,
	streaming: boolean,
): void {
	if (!streaming) {
		retractAll();
		return;
	}
	if (capture === undefined) return;
	const sources = deps.sources();
	const activeId = capture.active_source?.input_id ?? capture.live_inputs[0];
	const activeCamera =
		activeId === undefined ? undefined : nameFor(activeId, sources);
	const lost = new Set<string>();
	if (capture.state !== "standby" && activeCamera !== undefined) {
		for (const degraded of capture.degraded_inputs) {
			const name = nameFor(degraded.input_id, sources);
			if (name === undefined || degraded.input_id === activeId) continue;
			const id = `capture-input-lost:${degraded.input_id}`;
			lost.add(id);
			raise(
				id,
				`Camera ${name} lost — streaming continues on ${activeCamera}`,
				"notifications.captureInputLost",
				{ name, activeCamera },
			);
		}
	}
	for (const id of [...standing]) {
		if (id.startsWith("capture-input-lost:") && !lost.has(id)) retract(id);
	}

	if (capture.state === "standby") {
		raise(
			"capture-standby",
			"All cameras lost — the stream is on standby and resumes automatically when a camera returns",
			"notifications.captureStandby",
		);
		if (standbySince === undefined) {
			standbySince = capture.standby_since_ms ?? deps.now();
			longStandby();
		}
	} else {
		clearStandbyTimer();
		standbySince = undefined;
		retract("capture-standby");
		retract("capture-standby-long");
	}

	const suspension = capture.suspension?.kind;
	const notices = [
		[
			"composition_primary_absent",
			"capture-composition-suspended",
			"notifications.captureCompositionSuspended",
			"Main camera lost — showing the second camera full screen; picture-in-picture returns automatically",
		],
		[
			"passthrough_source_absent",
			"capture-passthrough-suspended",
			"notifications.capturePassthroughSuspended",
			"The camera is unavailable — streaming continues on standby and restores its usual mode automatically",
		],
		[
			"rate_adapted",
			"capture-rate-adapted",
			"notifications.captureRateAdapted",
			"Streaming at the backup camera's available quality; your settings return when the main camera is back",
		],
	] as const;
	for (const [kind, id, key, message] of notices) {
		if (suspension === kind) raise(id, message, key);
		else retract(id);
	}
}
