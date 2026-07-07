/*
 * Live start-failure reason → copy mapping (C7).
 *
 * LiveView reads the `reason` field of a failed streaming.start and maps it to a
 * SPECIFIC `live.startFailed.*` message (falling back to `generic`). This test
 * pins two invariants without mounting the whole component:
 *   1. STREAM_START_REASON_KEYS (parsed from the real LiveView source) still
 *      carries all FOUR audio/source entries — a merge race that clobbered one
 *      would silently drop its specific copy. See the task-13/14 clobber note.
 *   2. The reason→copy mapping (replicated from LiveView's startFailedMessage)
 *      resolves source_lost / source_unavailable to their OWN copy, not generic.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../../../../packages/i18n/src/en/index";

const SELF = fileURLToPath(import.meta.url);
const LIVE_VIEW = path.resolve(path.dirname(SELF), "../main/LiveView.svelte");

/** The four audio/source reason codes that carry specific start-failure copy. */
const REQUIRED_KEYS = [
	"audio_source_probe_failed",
	"audio_codec_unsupported_transport",
	"source_lost",
	"source_unavailable",
] as const;

/** Extract the STREAM_START_REASON_KEYS array literal from the live source. */
function parseReasonKeys(): string[] {
	const src = readFileSync(LIVE_VIEW, "utf8");
	const block = src.match(
		/STREAM_START_REASON_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const;/,
	);
	if (block === null) throw new Error("STREAM_START_REASON_KEYS not found");
	return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

const startFailed = en.live.startFailed as Record<string, string>;

/** Faithful replica of LiveView.startFailedMessage: array gate → dict lookup. */
function startFailedMessage(reason: string, keys: readonly string[]): string {
	return keys.includes(reason) ? startFailed[reason] : startFailed.generic;
}

describe("live start-failed reason mapping (C7)", () => {
	const keys = parseReasonKeys();

	it("STREAM_START_REASON_KEYS still carries all four audio/source entries (no merge-race clobber)", () => {
		for (const key of REQUIRED_KEYS) {
			expect(keys, `missing ${key}`).toContain(key);
		}
	});

	it("renders source_lost / source_unavailable copy from reason, distinct from generic", () => {
		expect(startFailedMessage("source_lost", keys)).toBe(startFailed.source_lost);
		expect(startFailedMessage("source_unavailable", keys)).toBe(
			startFailed.source_unavailable,
		);
		expect(startFailed.source_lost).not.toBe(startFailed.generic);
		expect(startFailed.source_unavailable).not.toBe(startFailed.generic);
		expect(startFailed.source_lost.length).toBeGreaterThan(0);
		expect(startFailed.source_unavailable.length).toBeGreaterThan(0);
	});

	it("keeps the pre-existing audio entries mapping to their own copy", () => {
		expect(startFailedMessage("audio_source_probe_failed", keys)).toBe(
			startFailed.audio_source_probe_failed,
		);
		expect(startFailedMessage("audio_codec_unsupported_transport", keys)).toBe(
			startFailed.audio_codec_unsupported_transport,
		);
	});

	it("falls back to generic copy for an unknown reason", () => {
		expect(startFailedMessage("some_unknown_reason", keys)).toBe(
			startFailed.generic,
		);
	});
});
