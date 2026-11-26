import type { ModemMutationBlock } from "@ceraui/rpc/schemas";
import { routerSubnetCheckProof } from "../network/router-subnet-verify.ts";
import { readUdevExportDb } from "./modem-id-path-source.ts";
import {
	currentMutationBlockPublication,
	currentMutationBlocks,
} from "./mutation-blocks.ts";
import { readMutationEntry } from "./mutation-journal.ts";
import { isMutationJournalRevisionCurrent } from "./mutation-journal-revision.ts";
import { statesMatch } from "./mutation-rollback.ts";
import { resolveMutationDevice } from "./router-subnet-recovery-device.ts";

/** The card's hint is not permission: the action re-resolves under key exclusion. */
export async function operatorMutationBlocks(): Promise<
	readonly ModemMutationBlock[]
> {
	const { blocks, readableKeys, revision } = currentMutationBlockPublication();
	const withoutCheck = (block: ModemMutationBlock): ModemMutationBlock => ({
		...block,
		devicePresent: true,
		checkable: false,
	});
	const hidden = () => currentMutationBlocks().map(withoutCheck);
	if (!isMutationJournalRevisionCurrent(revision)) return hidden();
	try {
		let database: Promise<string> | undefined;
		const readOnce = () => (database ??= readUdevExportDb());
		const scoped: ModemMutationBlock[] = [];
		for (const block of blocks) {
			// Rereading known damage would invalidate the publication for healthy rows too.
			if (!readableKeys.has(block.stableKey)) {
				scoped.push(withoutCheck(block));
				continue;
			}
			const entry = await readMutationEntry(block.stableKey);
			if (entry?.state !== block.state || entry.kind !== block.kind)
				return hidden();
			const device = await resolveMutationDevice(entry, readOnce);
			const checkable =
				entry.state === "failed" &&
				device.status === "present" &&
				(entry.kind === "router-subnet"
					? routerSubnetCheckProof(
							entry.preState,
							device.ifname,
						)?.isCurrent() === true
					: entry.kind === "usb-mode" &&
						device.identity === "usb-descriptor" &&
						statesMatch(entry.preState, device.state));
			scoped.push({
				...block,
				devicePresent: device.status !== "absent",
				checkable,
			});
		}
		if (isMutationJournalRevisionCurrent(revision)) return scoped;
	} catch {
		// An unavailable inventory or slot must not advertise a verification.
	}
	return hidden();
}
