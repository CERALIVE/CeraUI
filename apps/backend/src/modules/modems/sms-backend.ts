import { getCellularStack } from "../cellular/cellular-stack.ts";
import { readDbusSmsInbox } from "./dbus-sms.ts";
import { readSmsInbox, type SmsInboxResult } from "./mmcli-sms.ts";

export interface SmsBackendReaders {
	readonly readMmcli?: typeof readSmsInbox;
	readonly readDbus?: typeof readDbusSmsInbox;
}

export async function readSmsInboxForBackend(
	selector: string,
	readers: SmsBackendReaders = {},
): Promise<SmsInboxResult> {
	if (getCellularStack().backend === "mmcli") {
		return await (readers.readMmcli ?? readSmsInbox)(selector);
	}
	const result = await (readers.readDbus ?? readDbusSmsInbox)(selector);
	return result.ok ? { ok: true, messages: [...result.messages] } : result;
}
