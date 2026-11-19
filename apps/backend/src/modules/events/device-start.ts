import type { LogBootInfo } from "@ceraui/rpc/schemas";
import { listBoots } from "../device-logs/classified-boots.ts";
import { collectVersionContext } from "../system/version-context.ts";
import { emitDeviceEvent } from "./device-emit.ts";
import { appendBoot } from "./store.ts";

export async function recordDeviceStart(): Promise<void> {
	const versions = await collectVersionContext();
	const { bootId, ...flat } = versions;
	let previous: LogBootInfo | undefined;
	try {
		previous = (await listBoots()).find((boot) => boot.index === -1);
	} catch {
		// Journal availability must not prevent keeping this boot's versions.
	}
	try {
		appendBoot({ bootId, startedAt: Date.now(), versions });
	} catch {
		// A failed boot append must not suppress the independent event record.
	}
	emitDeviceEvent("device_started", {
		...flat,
		previousBootId: previous?.bootId ?? null,
		previousShutdown:
			previous?.shutdown === "current" ? null : (previous?.shutdown ?? null),
	});
	if (previous?.shutdown === "unclean") {
		emitDeviceEvent("previous_boot_unclean", {
			bootId: previous.bootId,
			evidence: previous.evidence,
		});
	}
}
