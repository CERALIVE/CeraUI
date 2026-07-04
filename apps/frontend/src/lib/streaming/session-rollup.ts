/**
 * Per-session ingest rollup — device-local only.
 *
 * Folds the live `status.linkTelemetry` feed (already broadcast by the backend,
 * no new collector) plus the live configured bitrate into a single end-of-stream
 * summary: peak/avg bitrate, per-link uptime %, and a bond drop-event count. The
 * IngestStats panel samples one {@link SessionSample} per telemetry tick while
 * streaming, then calls {@link computeSessionRollup} on the streaming→idle edge.
 *
 * Everything here is pure and rune-free so it is fully unit-testable and carries
 * NO network surface — there is no cloud/platform call anywhere in this module or
 * its consumer. The export helpers ({@link rollupToJson}, {@link rollupToCsv})
 * serialise the rollup for a client-side `URL.createObjectURL` download; they
 * never transmit it.
 */
import type { LinkTelemetryEntry } from "@ceraui/rpc/schemas";

/** One sampled link inside a {@link SessionSample}. */
export interface SessionSampleLink {
	iface: string;
	/** A stale link counts as down for uptime/drop purposes. */
	stale: boolean;
	/** Round-trip time at sample time, ms. */
	rtt: number;
	/** Cumulative NAK counter at sample time (monotonic per link). */
	nak: number;
	/** Bond weight share at sample time, percent. */
	weight: number;
}

/** One sampled instant of a streaming session. */
export interface SessionSample {
	/** Configured bitrate at sample time, in kbps. */
	bitrateKbps: number;
	/** Wall-clock instant the sample was taken, ms epoch (drives duration). */
	capturedAt: number;
	/** Per-link telemetry at sample time. */
	links: ReadonlyArray<SessionSampleLink>;
}

/** Per-link rollup entry: the share of the session the link was carrying. */
export interface SessionLinkRollup {
	iface: string;
	/** Percent of samples the link was present and fresh (0–100, integer). */
	uptimePercent: number;
	/** Mean bond weight share while the link was present (0–100, integer). */
	contribution: number;
	/** Total NAKs observed (peak of the monotonic cumulative counter). */
	nakTotal: number;
	/** Mean RTT while the link was present, ms (rounded). */
	avgRtt: number;
}

/** The end-of-session summary surfaced after the stream stops. */
export interface SessionRollup {
	/** Number of telemetry samples folded into this rollup. */
	sampleCount: number;
	/** Highest configured bitrate observed during the session, kbps. */
	peakBitrateKbps: number;
	/** Mean configured bitrate across the session, kbps (rounded). */
	avgBitrateKbps: number;
	/**
	 * Bond drop events: each time any link transitioned from up (present + fresh)
	 * to down (absent or stale) between consecutive samples. Summed across links.
	 */
	dropCount: number;
	/** Session wall-clock span (last − first sample instant), ms (≥ 0). */
	durationMs: number;
	/** Per-link uptime + diagnostics, in first-seen interface order. */
	links: SessionLinkRollup[];
}

/** Coerce any numeric to a finite, non-negative integer count (else 0). */
function asCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.trunc(value)
		: 0;
}

/**
 * Build a {@link SessionSample} from the live bitrate and a telemetry frame's
 * links. `undefined`/invalid bitrate collapses to 0; only `iface` + `stale` are
 * retained (RTT/NAK/weight are live-only and not part of the session summary).
 */
export function createSample(
	bitrateKbps: number | undefined,
	links:
		| ReadonlyArray<
				Pick<
					LinkTelemetryEntry,
					"iface" | "stale" | "rtt_ms" | "nak_count" | "weight_percent"
				>
		  >
		| undefined,
	capturedAt: number = Date.now(),
): SessionSample {
	return {
		bitrateKbps: asCount(bitrateKbps),
		capturedAt,
		links: (links ?? []).map((l) => ({
			iface: l.iface,
			stale: l.stale === true,
			rtt: asCount(l.rtt_ms),
			nak: asCount(l.nak_count),
			weight: asCount(l.weight_percent),
		})),
	};
}

/** A link is "up" in a sample when it is present and not stale. */
function isUp(sample: SessionSample, iface: string): boolean {
	const link = sample.links.find((l) => l.iface === iface);
	return link !== undefined && !link.stale;
}

/**
 * Reduce a session's samples into a {@link SessionRollup}. An empty session
 * yields zeroed metrics and no links (never throws). Bitrate peak/avg are over
 * the configured bitrate; uptime and drops are derived purely from per-link
 * presence + staleness across the sample sequence.
 */
export function computeSessionRollup(
	samples: ReadonlyArray<SessionSample>,
): SessionRollup {
	const sampleCount = samples.length;
	if (sampleCount === 0) {
		return {
			sampleCount: 0,
			peakBitrateKbps: 0,
			avgBitrateKbps: 0,
			dropCount: 0,
			durationMs: 0,
			links: [],
		};
	}

	let peak = 0;
	let sum = 0;
	for (const s of samples) {
		const br = asCount(s.bitrateKbps);
		if (br > peak) peak = br;
		sum += br;
	}

	const first = samples[0];
	const last = samples[sampleCount - 1];
	const durationMs =
		first !== undefined && last !== undefined
			? Math.max(0, last.capturedAt - first.capturedAt)
			: 0;

	// Interfaces in first-seen order across the whole session.
	const order: string[] = [];
	const seen = new Set<string>();
	for (const s of samples) {
		for (const l of s.links) {
			if (!seen.has(l.iface)) {
				seen.add(l.iface);
				order.push(l.iface);
			}
		}
	}

	let dropCount = 0;
	const links: SessionLinkRollup[] = order.map((iface) => {
		let upSamples = 0;
		let wasUp = false;
		let presentSamples = 0;
		let weightSum = 0;
		let rttSum = 0;
		let nakTotal = 0;
		for (let i = 0; i < samples.length; i++) {
			const sample = samples[i];
			if (sample === undefined) continue;
			const up = isUp(sample, iface);
			if (up) upSamples++;
			// Count a drop only on a real up→down edge (not the initial sample).
			if (i > 0 && wasUp && !up) dropCount++;
			wasUp = up;

			const link = sample.links.find((l) => l.iface === iface);
			if (link !== undefined) {
				presentSamples++;
				weightSum += asCount(link.weight);
				rttSum += asCount(link.rtt);
				if (link.nak > nakTotal) nakTotal = asCount(link.nak);
			}
		}
		return {
			iface,
			uptimePercent: Math.round((upSamples / sampleCount) * 100),
			contribution:
				presentSamples > 0 ? Math.round(weightSum / presentSamples) : 0,
			nakTotal,
			avgRtt: presentSamples > 0 ? Math.round(rttSum / presentSamples) : 0,
		};
	});

	return {
		sampleCount,
		peakBitrateKbps: peak,
		avgBitrateKbps: Math.round(sum / sampleCount),
		dropCount,
		durationMs,
		links,
	};
}

/** Serialise a rollup to a stable, pretty-printed JSON string (device-local). */
export function rollupToJson(rollup: SessionRollup): string {
	return JSON.stringify(rollup, null, 2);
}

/** Escape a CSV field per RFC 4180 (quote + double inner quotes when needed). */
function csvField(value: string | number): string {
	const s = String(value);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise a rollup to CSV: a `metric,value` block for the session totals, a
 * blank separator, then an `iface,uptime_percent` block per link. Plain text,
 * no transmission — fed straight into a client-side Blob download.
 */
export function rollupToCsv(rollup: SessionRollup): string {
	const lines: string[] = [
		"metric,value",
		`peak_bitrate_kbps,${csvField(rollup.peakBitrateKbps)}`,
		`avg_bitrate_kbps,${csvField(rollup.avgBitrateKbps)}`,
		`drop_count,${csvField(rollup.dropCount)}`,
		`sample_count,${csvField(rollup.sampleCount)}`,
		`duration_ms,${csvField(rollup.durationMs)}`,
		"",
		"iface,uptime_percent,contribution_percent,nak_total,avg_rtt_ms",
		...rollup.links.map(
			(l) =>
				`${csvField(l.iface)},${csvField(l.uptimePercent)},${csvField(l.contribution)},${csvField(l.nakTotal)},${csvField(l.avgRtt)}`,
		),
	];
	return lines.join("\n");
}
