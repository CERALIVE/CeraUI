import { z } from "zod";
import { diagnoseRadio, metric, type RadioEvidence } from "./radio-health.ts";

/** Synthetic schedules for exercising passive evidence rules. */
export const radioReplaySchema = z.object({
	durationMs: z.number().positive(),
	events: z.array(
		z.object({
			at: z.number().nonnegative(),
			kind: z.enum(["reset", "disconnect"]),
		}),
	),
	transmitWindows: z.array(
		z.object({
			start: z.number().nonnegative(),
			end: z.number().nonnegative(),
			source: z.enum(["payload-counter", "reviewed-control-activity"]),
		}),
	),
	quietWindows: z.array(
		z.object({
			start: z.number().nonnegative(),
			end: z.number().nonnegative(),
		}),
	),
});
export function replayRadio(input: unknown): {
	resets: number;
	coincidentResets: number;
	quietResets: number;
	controlOnlyResets: number;
} {
	const data = radioReplaySchema.parse(input);
	for (const window of [...data.transmitWindows, ...data.quietWindows])
		if (window.end < window.start || window.end > data.durationMs)
			throw new Error("Invalid replay window");
	const evidence = (at: number): RadioEvidence => ({
		at,
		registration: "unknown",
		homeNetwork: undefined,
		rejectedNetwork: undefined,
		refused: false,
		granted: false,
		failedProbes: 0,
		probeAt: undefined,
		rsrp: metric(null, "replay", "dBm", "unknown", at),
		quality: metric(null, "replay", "dB", "unknown", at),
		transmitting: "unknown",
		usb: [],
	});
	let resets = 0,
		coincidentResets = 0,
		quietResets = 0,
		controlOnlyResets = 0;
	for (const event of data.events) {
		if (event.at > data.durationMs) throw new Error("Event outside replay");
		if (event.kind !== "reset") continue;
		resets++;
		const window = data.transmitWindows.find(
			(window) => event.at >= window.start && event.at <= window.end,
		);
		if (
			data.quietWindows.some(
				(window) => event.at >= window.start && event.at <= window.end,
			)
		)
			quietResets++;
		if (!window) continue;
		const current = { ...evidence(window.end), usb: [event] };
		const neighbour = {
			...evidence(window.end),
			intervalStart: window.start,
			transmitting: "yes" as const,
			...(window.source === "reviewed-control-activity"
				? { transmitContrast: { idleAt: 0, activeAt: window.start } }
				: {}),
		};
		if (
			diagnoseRadio(current, evidence(0), { neighbour }).kind === "disturbed"
		) {
			coincidentResets++;
			if (window.source === "reviewed-control-activity") controlOnlyResets++;
		}
	}
	return { resets, coincidentResets, quietResets, controlOnlyResets };
}
