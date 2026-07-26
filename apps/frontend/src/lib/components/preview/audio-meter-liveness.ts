/**
 * Audio-meter liveness primitives — pure, rune-free.
 *
 * Applies the rule `stores/hud/staleness.ts` already codified for the HUD: a
 * frame's ARRIVAL is not evidence that the thing it measures is alive — only its
 * CONTENT is. The HUD learned this because a whole-source push refreshes every
 * interface's object reference at once; the audio meter needs it for the mirror
 * reason: the engine emits a level every 100–200 ms for as long as ALSA keeps
 * clocking buffers, whether or not those buffers still carry a changing signal.
 *
 * Confirmed on a Rock 5B+: a RØDE HDMI-to-USB-C with no source on its HDMI input
 * kept its capture substream RUNNING (`/proc/asound/card5/pcm0c/sub0/status`
 * state RUNNING, `hw_ptr` advancing) while delivering a fixed idle payload, so
 * the engine truthfully published
 * `rms_db:[-41.522344822589105,-44.116395350676385]` — bit-identical, 226 frames
 * out of 226 over 45 s. Every liveness check in the stack measures buffer
 * DELIVERY (cerastream's 2 s sidecar delivery probe and its streaming-owner
 * deadline, the bridge's foreign-card gate, this component's own watchdog), and
 * a device clocking frozen content passes all of them. −41.5 dBFS on a −60 floor
 * renders as a 31 % bar that never moves: the reported "meter frozen at some
 * level" state.
 *
 * The same rule also closes a second, quieter gap. cerastream hydrates a NEW
 * `audio-level` subscriber with its cached last observation, and the idle
 * sidecar (unlike the streaming owner) has no delivery deadline — so a sidecar
 * that stalls after delivering at least one sample leaves that stale level
 * cached, and every bridge reconnect replays it. Arrival-stamping restamped the
 * watchdog on each replay; content-stamping does not.
 *
 * Rune-free so the whole rule is unit-testable under plain vitest with fake
 * timers; `LiveAudioMeter.svelte` layers the runes on top.
 */

import type { AudioLevelMessage } from "@ceraui/rpc/schemas";

/**
 * Staleness deadline. The engine sidecar emits at ≤10 Hz (≥100 ms), so a meter
 * that has said nothing NEW for this long has stopped telling us anything —
 * whether its frames stopped or merely stopped changing. Comfortably above the
 * cadence so a normal gap never trips it.
 */
export const AUDIO_METER_STALE_MS = 2_000;

/** How often the watchdog clock re-evaluates, so staleness resolves with no frame. */
export const AUDIO_METER_TICK_MS = 500;

/**
 * dBFS at or below which a channel reads as empty. MUST match
 * `AudioLevelMeter.svelte`'s `FLOOR_DB`: a reading this module calls silent has
 * to be one that component renders as its `silent` state, or the two disagree
 * about what the operator is looking at.
 */
export const AUDIO_METER_FLOOR_DB = -60;

/** Last-seen content fingerprint + the time that content last changed. */
export interface MeterFreshness {
	readonly fingerprint: string | undefined;
	readonly lastChangedAt: number;
}

/** Nothing has ever arrived. `lastChangedAt: 0` is what {@link isMeterStale} reads as "no verdict yet". */
export const INITIAL_METER_FRESHNESS: MeterFreshness = {
	fingerprint: undefined,
	lastChangedAt: 0,
};

/**
 * Does this level read as digital silence — every channel at or below the floor?
 * Mirrors `AudioLevelMeter.svelte`'s `silent` derivation (peak-driven, treating a
 * missing or non-finite dB as empty), including its "no channels at all" case.
 */
export function isDigitalSilence(level: AudioLevelMessage): boolean {
	const peak = level.peak_db ?? [];
	const rms = level.rms_db ?? [];
	const channelCount = Math.max(peak.length, rms.length);
	if (channelCount === 0) return true;
	for (let i = 0; i < channelCount; i += 1) {
		const db = peak[i];
		if (db !== undefined && Number.isFinite(db) && db > AUDIO_METER_FLOOR_DB) {
			return false;
		}
	}
	return true;
}

/**
 * Fingerprint everything a level frame actually SAYS: the rendered per-channel
 * values, plus the identity/owner it attributes them to. Two frames with the
 * same fingerprint carry the same information, so the second one is a repeat
 * however fresh its envelope is.
 *
 * The identity/owner pair is deliberately included: a sidecar→streaming handoff
 * or a switch to another card is genuinely new information even in the unlikely
 * case the numbers coincide, so it must count as life.
 */
export function meterFingerprint(level: AudioLevelMessage): string {
	return JSON.stringify([
		level.source?.identity ?? null,
		level.source?.owner ?? null,
		level.channels ?? null,
		level.rms_db ?? null,
		level.peak_db ?? null,
	]);
}

/**
 * Advance the liveness clock with one frame. `lastChangedAt` moves ONLY when the
 * frame carries new information; a repeat returns `previous` unchanged (same
 * object identity, so a runes assignment is a no-op).
 *
 * Two kinds of frame always count as life, however long they repeat, because
 * both are the meter working correctly rather than the meter lying:
 *
 * - an explicit engine `unavailable` marker — it already states the gap, and
 *   ageing it out would only replace one unavailable render with another while
 *   discarding the engine's typed reason;
 * - genuine digital silence — an unchanging floor reading is exactly what a live
 *   meter reports for a muted mic, and `AudioLevelMeter` renders it as its own
 *   truthful `silent` state. Only a NON-silent frozen reading is the lie, because
 *   only that one draws bars an operator reads as live signal.
 *
 * A feed that stops entirely is still caught: no frame means no call, so the
 * clock simply stops advancing.
 */
export function trackMeterFreshness(
	previous: MeterFreshness,
	level: AudioLevelMessage | undefined,
	now: number,
): MeterFreshness {
	if (level === undefined) return previous;
	if (level.unavailable === true || isDigitalSilence(level)) {
		// Clear the fingerprint so the next real reading always registers as new.
		return { fingerprint: undefined, lastChangedAt: now };
	}
	const fingerprint = meterFingerprint(level);
	if (previous.fingerprint === fingerprint) return previous;
	return { fingerprint, lastChangedAt: now };
}

/**
 * Has the meter gone quiet — no NEW information for `staleMs`? False until the
 * first frame has ever landed (`lastChangedAt === 0`), which is the distinct
 * `pending` state the component renders instead.
 */
export function isMeterStale(
	freshness: MeterFreshness,
	now: number,
	staleMs: number = AUDIO_METER_STALE_MS,
): boolean {
	if (freshness.lastChangedAt === 0) return false;
	return now - freshness.lastChangedAt > staleMs;
}
