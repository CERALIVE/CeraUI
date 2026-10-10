import type {
	JudgedOsReceipt,
	OsStageReceipt,
} from "../../modules/system/update-orchestrator/os-agent.ts";
import { readReceiptFile } from "../../modules/system/update-orchestrator/os-receipt-file-identity.ts";

export function receiptJudgment(
	receipt: OsStageReceipt,
	dir?: string,
): JudgedOsReceipt {
	const identity = dir === undefined ? null : readReceiptFile(dir)?.identity;
	return {
		receipt,
		identity: identity ?? {
			dev: "1",
			ino: "1",
			size: "1",
			mtimeNs: "1",
			birthtimeNs: "1",
			sha256: "a".repeat(64),
		},
	};
}
