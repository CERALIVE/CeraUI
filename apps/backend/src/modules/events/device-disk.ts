import { LOW_DISK_THRESHOLD_BYTES } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { emitDeviceEvent } from "./device-emit.ts";

const bytes = z.number().int().nonnegative();
const diskSchema = z
	.object({ total: bytes, used: bytes })
	.refine((disk) => disk.used <= disk.total);

export function createDiskEventObserver(): (reading: unknown) => void {
	let wasLow = false;
	return (reading) => {
		const parsed = diskSchema.safeParse(reading);
		if (!parsed.success) return;
		const freeBytes = parsed.data.total - parsed.data.used;
		const low = freeBytes < LOW_DISK_THRESHOLD_BYTES;
		if (low === wasLow) return;
		wasLow = low;
		emitDeviceEvent(low ? "disk_low" : "disk_ok", { freeBytes });
	};
}
