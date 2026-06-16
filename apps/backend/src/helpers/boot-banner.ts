/*
    Boot banner + per-phase timing helpers.

    Pure, side-effect-free building blocks for the startup output emitted by
    `main.ts`. They are kept out of `main.ts` so they can be unit-tested without
    importing the entry point (which would boot the whole app on import). The
    timer takes an injectable clock so phase deltas are deterministic in tests.

    SECRET SAFETY: the banner only ever renders the fixed boot facts (app name,
    version, NODE_ENV, MOCK_SCENARIO, listening port). It must NEVER be passed a
    PIN, token, PASETO, or bcrp key — there is no field that could carry one.
*/

/** Fixed product name shown in the banner (NOT the npm package name "backend"). */
export const APP_NAME = "CeraUI";

export interface BootBannerInfo {
	/** Product name, e.g. "CeraUI". */
	name: string;
	/** Package version, e.g. "2026.6.1". */
	version: string;
	/** NODE_ENV ("development" / "production" / …). */
	env: string;
	/** Active MOCK_SCENARIO in dev; `null` in production (no scenario). */
	scenario: string | null;
	/** Bound listen port; `null` when not yet known (banner printed pre-listen). */
	port: number | null;
}

/**
 * Build the one-line startup banner. Only fields that are known are rendered:
 * `scenario` and `port` are omitted when `null`, so the same function serves the
 * pre-listen banner (no port yet) and a fully-populated banner in tests.
 */
export function buildBootBanner(info: BootBannerInfo): string {
	const parts = [`🎬 ${info.name} v${info.version}`, `env=${info.env}`];
	if (info.scenario !== null) {
		parts.push(`scenario=${info.scenario}`);
	}
	if (info.port !== null) {
		parts.push(`port=${info.port}`);
	}
	return parts.join(" · ");
}

/**
 * Final "ready" line printed once the server is listening. Carries the real
 * bound port and the total elapsed boot time. `port` is `null` only if the
 * server failed to report a bound address.
 */
export function formatReadyLine(
	elapsedMs: number,
	port: number | null,
): string {
	const where = port !== null ? ` on port ${port}` : "";
	return `✅ ${APP_NAME} ready${where} in ${Math.round(elapsedMs)}ms`;
}

/** A passive boot timer: formats per-phase lines and the total elapsed time. */
export interface BootTimer {
	/** Format (does not log) a phase marker with ms elapsed since the prior mark. */
	phase(icon: string, label: string): string;
	/** Total elapsed ms since the timer was created. */
	elapsedMs(): number;
}

/**
 * Create a {@link BootTimer}. The clock defaults to `performance.now()` (a
 * monotonic, passive read — no blocking) and is injectable for deterministic
 * tests. Each `phase()` call reports the delta since the previous `phase()` call
 * (or since creation for the first call); `elapsedMs()` reports the total.
 */
export function createBootTimer(
	now: () => number = () => performance.now(),
): BootTimer {
	const start = now();
	let last = start;
	return {
		phase(icon: string, label: string): string {
			const current = now();
			const delta = Math.round(current - last);
			last = current;
			return `${icon} ${label} (+${delta}ms)`;
		},
		elapsedMs(): number {
			return Math.round(now() - start);
		},
	};
}
