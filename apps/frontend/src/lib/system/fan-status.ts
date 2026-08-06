/**
 * Fan presence + duty cycle — the render side of `@ceraui/rpc` `fanSchema`.
 *
 * The quantity is a DUTY CYCLE (`pwm1 / 255`, computed once in the backend
 * collector) and nothing else. The reference board's fan is 2-wire: it exposes
 * no tachometer, so there is no speed to show. Nothing in this module, or in any
 * copy it drives, may name or imply one — `no-rpm-copy.test.ts` sweeps all ten
 * locales for that. The thermal cooling device's `cur_state`/`max_state` is
 * likewise not a percentage and is not on the wire at all.
 *
 * FOUR states, and `absent` is a POSITIVE claim, not a gap:
 *
 *   running — a fan exists and is being driven above zero.
 *   off     — a fan exists and is being driven at exactly zero. A MEASURED zero
 *             is a real reading and must never render as the `—` placeholder.
 *   absent  — this board has no controllable fan. Provable, so it is stated in
 *             words; an em-dash here would read as "still loading".
 *   unknown — nothing has been published yet (a dev host is gated silent), or a
 *             present fan's duty could not be read this tick.
 */
import type { FanReading, FanState } from "@ceraui/rpc/schemas";

export type { FanState };

/**
 * An absent snapshot is `unknown`, never `absent`: a broadcast that has not
 * arrived says nothing about the hardware. That distinction is the entire
 * reason this signal has four states rather than three.
 */
export function deriveFanState(reading: FanReading | undefined): FanState {
	return reading?.state ?? "unknown";
}

/**
 * The 0-1 fraction a duty bar may be drawn to, or `null` when no bar is
 * permitted. Only `running`/`off` have a real 0-100 denominator; `absent` and
 * `unknown` have none, so drawing an empty track for them would picture a
 * measurement that does not exist.
 */
export function fanDutyFraction(
	reading: FanReading | undefined,
): number | null {
	if (reading === undefined) return null;
	if (reading.state === "running" || reading.state === "off") {
		return Math.min(1, Math.max(0, reading.dutyPercent / 100));
	}
	return null;
}
