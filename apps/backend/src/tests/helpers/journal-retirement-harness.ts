import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	defaultMutationJournalFs,
	mutationSlotName,
	setMutationJournalDeps,
} from "../../modules/modems/mutation-journal.ts";

export function retirementFault(root: string, failures: number) {
	let remaining = failures;
	let unlinks = 0;
	let syncs = 0;
	setMutationJournalDeps({
		dir: root,
		now: () => 2,
		fs: {
			...defaultMutationJournalFs,
			unlink: async (path) => {
				unlinks++;
				if (remaining-- > 0) {
					throw Object.assign(new Error("retirement EIO"), { code: "EIO" });
				}
				await defaultMutationJournalFs.unlink(path);
			},
			fsyncDir: async (dir) => {
				syncs++;
				await defaultMutationJournalFs.fsyncDir(dir);
			},
		},
	});
	return {
		unlinks: () => unlinks,
		syncs: () => syncs,
		repair: () => {
			remaining = 0;
		},
	};
}

export function journalBytes(root: string, key = "usb:b"): Buffer {
	return readFileSync(join(root, `${mutationSlotName(key)}.json`));
}

export function journalFiles(root: string): readonly string[] {
	return readdirSync(root).filter((name) => name.endsWith(".json"));
}
