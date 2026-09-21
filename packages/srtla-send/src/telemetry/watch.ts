import {
	readTelemetry,
	SENDER_TELEMETRY_STALE_MS,
	type Telemetry,
} from "./index";

/** Payload handed to a {@link watchTelemetry} callback on every tick. */
export interface TelemetryUpdate {
	/** Current snapshot, or `null` if absent/unparseable/schema-invalid. */
	data: Telemetry | null;
	/**
	 * `true` when there is no live snapshot: either `data` is `null`, or its
	 * `last_updated_ms` is older than {@link SENDER_TELEMETRY_STALE_MS}.
	 */
	stale: boolean;
}

export interface WatchTelemetryOptions {
	/** Poll cadence in milliseconds. Default 1000ms (the producer write cadence). */
	intervalMs?: number;
}

export interface WatchTelemetryHandle {
	/** Stop polling. Idempotent; no callback fires after this resolves. */
	stop: () => void;
}

/**
 * Poll `path` on a fixed cadence, invoking `cb` with the current
 * {@link TelemetryUpdate} each tick.
 *
 * Fires once immediately so a consumer gets current state without waiting a full
 * interval, then repeats every `intervalMs` (default 1000ms). The `stale` flag is
 * computed per tick from `last_updated_ms`; an absent/invalid file yields
 * `{ data: null, stale: true }`. Call `stop()` to halt; a read already in flight
 * will not invoke `cb` afterward.
 */
export function watchTelemetry(
	path: string,
	cb: (update: TelemetryUpdate) => void,
	opts: WatchTelemetryOptions = {},
): WatchTelemetryHandle {
	const intervalMs = opts.intervalMs ?? 1000;
	let stopped = false;

	const tick = async (): Promise<void> => {
		const data = await readTelemetry(path);
		if (stopped) {
			return;
		}
		const stale =
			data === null ||
			Date.now() - data.last_updated_ms > SENDER_TELEMETRY_STALE_MS;
		cb({ data, stale });
	};

	void tick();
	const timer = setInterval(() => {
		void tick();
	}, intervalMs);

	return {
		stop: () => {
			stopped = true;
			clearInterval(timer);
		},
	};
}
