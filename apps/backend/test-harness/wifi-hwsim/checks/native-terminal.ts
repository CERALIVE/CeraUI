import { type HotspotToggleOutput, hotspotToggleOutputSchema } from '@ceraui/rpc/schemas';

/** The native observer consumes only a terminal Start for its selected device. */
export function nativeStartConfirmation(
	data: unknown,
	device: number,
): HotspotToggleOutput | undefined {
	if (typeof data !== 'string') return;
	const envelope: unknown = JSON.parse(data);
	if (!envelope || typeof envelope !== 'object' || !('wifi' in envelope)) return;
	const wifi = envelope.wifi;
	if (!wifi || typeof wifi !== 'object' || !('hotspot' in wifi)) return;
	const hotspot = wifi.hotspot;
	if (!hotspot || typeof hotspot !== 'object' || !('start' in hotspot)) return;
	const start = hotspot.start;
	if (
		!start ||
		typeof start !== 'object' ||
		!('device' in start) ||
		String(start.device) !== String(device)
	)
		return;
	const parsed = hotspotToggleOutputSchema.safeParse(start);
	if (parsed.success && parsed.data.accepted !== true) return parsed.data;
	return undefined;
}
