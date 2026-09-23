/**
 * capture-failover — the mid-stream standby / suspension / rate-adaptation
 * verdicts every live surface reads (LiveCockpit bands, LiveSourceSwitch chips
 * and the "Match this camera" action). Pure and rune-free.
 *
 * The wire shape is the producer's own `captureStatusSchema`. Every status enum
 * on it is OPEN (a plain string), so an unknown future token renders NOTHING
 * here rather than a wrong band.
 */
import {
	type ActiveEncode,
	type Framerate,
	normalizeFramerateToRung,
	normalizeResolutionToRung,
	RESOLUTION_ENGINE_DIMS,
	type Resolution,
} from "@ceraui/rpc/schemas";

export type CaptureStatus = NonNullable<ActiveEncode["capture"]>;

/** The engine's synthetic black leg; never listed in `switch_targets`. */
export const STANDBY_LEG_ID = "standby";

export type CaptureBand =
	| { kind: "standby" }
	| { kind: "composition-suspended" }
	| { kind: "passthrough-suspended" }
	| { kind: "rate-adapted"; mode: string | undefined };

export interface MatchAction {
	inputId: string;
	mode: string;
	resolution: Resolution;
	framerate: Framerate;
}

const SUSPENSION_BANDS: Record<string, CaptureBand["kind"]> = {
	composition_primary_absent: "composition-suspended",
	passthrough_source_absent: "passthrough-suspended",
	rate_adapted: "rate-adapted",
};

function isPositive(value: number | undefined): value is number {
	return value !== undefined && Number.isFinite(value) && value > 0;
}

export function formatCaptureMode(
	width: number | undefined,
	height: number | undefined,
	framerate: number | undefined,
): string | undefined {
	if (!isPositive(width) || !isPositive(height) || !isPositive(framerate)) {
		return undefined;
	}
	const rate =
		normalizeFramerateToRung(framerate) ?? Math.round(framerate * 100) / 100;
	return `${height}p${rate}`;
}

export function isCaptureStandby(
	capture: CaptureStatus | undefined,
	activeInput: string | undefined,
): boolean {
	return capture?.state === "standby" || activeInput === STANDBY_LEG_ID;
}

export function deriveCaptureBands(
	capture: CaptureStatus | undefined,
): CaptureBand[] {
	if (!capture) return [];
	const bands: CaptureBand[] = [];
	if (capture.state === "standby") bands.push({ kind: "standby" });
	const suspended = capture.suspension
		? SUSPENSION_BANDS[capture.suspension.kind]
		: undefined;
	if (suspended === "rate-adapted") {
		const source = capture.active_source;
		bands.push({
			kind: "rate-adapted",
			mode: formatCaptureMode(source?.width, source?.height, source?.framerate),
		});
	} else if (suspended !== undefined) {
		bands.push({ kind: suspended });
	}
	return bands;
}

function exactResolutionRung(
	width: number,
	height: number,
): Resolution | undefined {
	const rung = normalizeResolutionToRung(`${width}x${height}`);
	if (rung === undefined) return undefined;
	return RESOLUTION_ENGINE_DIMS[rung].endsWith(`x${height}`) ? rung : undefined;
}

export function deriveMatchAction(
	capture: CaptureStatus | undefined,
): MatchAction | undefined {
	if (!capture || capture.state === "standby") return undefined;
	if (capture.failover_rate_policy !== "retime") return undefined;
	const source = capture.active_source;
	if (!source || !(source.retimed || source.rescaled)) return undefined;
	const mode = formatCaptureMode(source.width, source.height, source.framerate);
	const resolution = exactResolutionRung(source.width, source.height);
	const framerate = normalizeFramerateToRung(source.framerate);
	if (
		mode === undefined ||
		resolution === undefined ||
		framerate === undefined
	) {
		return undefined;
	}
	return { inputId: source.input_id, mode, resolution, framerate };
}
