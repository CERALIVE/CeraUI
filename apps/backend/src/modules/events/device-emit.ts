import type { EventCode, EventParams } from "@ceraui/rpc/events";
import { emitEvent } from "./emit.ts";

export function emitDeviceEvent<C extends EventCode>(
	code: C,
	params: EventParams<C>,
): void {
	try {
		emitEvent(code, params);
	} catch {
		// Telemetry must not interrupt boot, power admission or an edge latch.
	}
}
