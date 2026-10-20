import { join } from "node:path";
import type {
	ModemMutationAckOutput,
	ModemMutationState,
} from "@ceraui/rpc/schemas";
import {
	acknowledgeMutation,
	decommissionMutation,
	rebaselineMutation,
} from "../../modules/modems/mutation-acknowledge.ts";
import {
	commitMutationEntry,
	defaultMutationJournalFs,
	mutationSlotName,
	readMutationEntry,
	setMutationJournalDeps,
} from "../../modules/modems/mutation-journal.ts";
import {
	deferred,
	seedFailedMutation,
} from "./journal-reconciliation-harness.ts";

export const retirementActions: readonly {
	readonly name: string;
	readonly state: ModemMutationState;
	readonly invoke: (
		key: string,
		signal?: AbortSignal,
	) => Promise<ModemMutationAckOutput>;
}[] = [
	{
		name: "acknowledge",
		state: "failed",
		invoke: (key, signal) =>
			acknowledgeMutation(key, "verified-rollback", signal),
	},
	{
		name: "rebaseline",
		state: "recommission-pending",
		invoke: rebaselineMutation,
	},
	{
		name: "decommission",
		state: "device-absent-quarantine",
		invoke: decommissionMutation,
	},
];

export async function seedRetirement(state: ModemMutationState): Promise<void> {
	await seedFailedMutation("usb:b");
	const entry = await readMutationEntry("usb:b");
	if (!entry) throw new Error("missing seeded slot");
	await commitMutationEntry({ ...entry, state });
}

export function holdRetirement(root: string, decommission: boolean) {
	const entered = deferred(),
		hold = deferred();
	const slot = join(root, `${mutationSlotName("usb:b")}.json`);
	let calls = 0;
	setMutationJournalDeps({
		dir: root,
		fs: {
			...defaultMutationJournalFs,
			unlink: async (path) => {
				if (!decommission && path === slot) {
					calls++;
					entered.release();
					await hold.promise;
				}
				await defaultMutationJournalFs.unlink(path);
			},
			rename: async (from, to) => {
				if (decommission && to === slot) {
					calls++;
					entered.release();
					await hold.promise;
				}
				await defaultMutationJournalFs.rename(from, to);
			},
		},
	});
	return {
		entered: entered.promise,
		release: hold.release,
		calls: () => calls,
	};
}
