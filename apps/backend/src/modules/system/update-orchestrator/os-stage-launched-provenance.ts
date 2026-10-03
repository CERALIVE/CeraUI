import { OsStageError } from "./os-stage-error.ts";
import type { OsStageJobRecord } from "./os-stage-job-files.ts";
import {
	type OsStagePrivateIdentity,
	readOsStagePrivateOwner,
} from "./os-stage-private-owner.ts";

/**
 * The launched owner's private-directory provenance: identity is captured once,
 * at acquisition or at the first proven adoption, and every release step then
 * re-asserts the authoritative private-owner shape against that identity.
 */
export function trackOsStagePrivateProvenance(directory: string, uid: number) {
	let identity: OsStagePrivateIdentity | undefined;
	const refuse = (refusal: string, cause?: unknown) =>
		new OsStageError("rauc_recovery_unproven", {
			...(cause === undefined ? {} : { cause }),
			diagnostics: { refusal },
		});
	return {
		captured: () => identity !== undefined,
		async capture(record: OsStageJobRecord): Promise<void> {
			try {
				identity = (await readOsStagePrivateOwner({ directory, uid, record }))
					.identity;
			} catch (cause) {
				throw refuse("private-provenance-mismatch", cause);
			}
		},
		/** `marked`: whether this owner has already published its release marker. */
		async assert(record: OsStageJobRecord, marked: boolean): Promise<void> {
			if (!identity) throw refuse("private-provenance-uncaptured");
			const token = `${record.attemptId}\n`;
			try {
				const owner = await readOsStagePrivateOwner({
					directory,
					uid,
					record,
					identity,
				});
				const { ready, release } = await owner.tokens();
				if (ready === token && release === (marked ? token : null)) return;
			} catch (cause) {
				throw refuse("private-provenance-mismatch", cause);
			}
			throw refuse("private-provenance-mismatch");
		},
	};
}
