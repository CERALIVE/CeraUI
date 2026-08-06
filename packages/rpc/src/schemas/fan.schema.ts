/**
 * Fan presence + PWM duty-cycle broadcast message schema (`fan` event).
 *
 * This is its OWN broadcast, deliberately NOT a sixth `device-stats` field: that
 * five-signal payload is frozen by the S1 lock, and adding to it is a contract
 * change rather than a tweak. It follows the `encoder-load` precedent exactly,
 * including the `isRealDevice()` gate on the emitter.
 *
 * THE INVARIANT THIS SCHEMA EXISTS TO PROTECT: the quantity is a DUTY CYCLE,
 * derived from the hwmon `pwm1` register over its full-scale 255, and nothing
 * else. The reference board's fan is 2-wire — it has no tachometer, exposes no
 * `fan1_input`, and therefore has no RPM to report — so there is deliberately no
 * `rpm` field here and no code path anywhere that could produce one. The thermal
 * cooling device's `cur_state`/`max_state` is likewise NOT a percentage: those
 * levels are an INDEX into the devicetree `cooling-levels` table
 * (`<0 120 150 180 210 240 255>` on the reference board), not a linear scale of
 * airflow, so dividing the index by the max would fabricate a denominator the
 * hardware never produced — the same class of lie the three-state encoder-load
 * model exists to prevent.
 *
 * FOUR states, and each is a distinct, provable claim:
 *
 * - `running` — a `pwm-fan` cooling device exists and its `pwm1` reads > 0.
 * - `off`     — the same, reading exactly 0. A MEASURED zero is a real reading,
 *               never an "unavailable"; the two must stay distinguishable.
 * - `absent`  — this board has NO `pwm-fan` cooling device at all. A positive,
 *               provable fact about the hardware (x86-minipc and any board
 *               without a controllable fan), not an unknown.
 * - `unknown` — a fan is present but its duty could not be read this tick, or
 *               nothing has been published yet (a dev host is gated silent).
 *
 * A shape that cannot distinguish `absent` from `unknown` is not acceptable —
 * that collapse is exactly the defect this signal exists to avoid.
 */
import { z } from 'zod';

/** Full scale of the hwmon `pwm1` register — the ONLY sanctioned denominator. */
export const FAN_PWM_FULL_SCALE = 255;

export const fanSchema = z.discriminatedUnion('state', [
	z.object({
		state: z.literal('running'),
		/** 0-100, strictly positive, derived from `pwm1 / 255`. */
		dutyPercent: z.number().gt(0).max(100),
	}),
	z.object({
		state: z.literal('off'),
		/** A measured zero — carried explicitly so it cannot read as a gap. */
		dutyPercent: z.literal(0),
	}),
	z.object({ state: z.literal('absent') }),
	z.object({ state: z.literal('unknown') }),
]);
export type FanReading = z.infer<typeof fanSchema>;
export type FanState = FanReading['state'];
