import {
	acknowledgeMutation,
	decommissionMutation,
} from "../../modules/modems/mutation-acknowledge.ts";
import {
	defaultMutationJournalFs,
	setMutationJournalDeps,
} from "../../modules/modems/mutation-journal.ts";
import { routerUsbSysfs } from "../../modules/modems/router-subnet-recovery-device.ts";

const [dir, key, mode] = process.argv.slice(2);
if (!dir || !key)
	throw new Error("crash fixture needs a private journal and key");
if (mode === "gone") {
	routerUsbSysfs.names = () => ["usb1"];
	routerUsbSysfs.rootPath = () =>
		"/sys/devices/platform/xhci/xhci-hcd.0.auto/usb1";
}
let renames = 0;
setMutationJournalDeps({
	dir,
	fs: {
		...defaultMutationJournalFs,
		rename: async (from, to) => {
			if (mode === "gone" && ++renames === 2) {
				process.kill(process.pid, "SIGKILL");
				throw new Error("crash did not stop the fixture");
			}
			await defaultMutationJournalFs.rename(from, to);
		},
		unlink: async () => {
			process.kill(process.pid, "SIGKILL");
			throw new Error("crash did not stop the fixture");
		},
	},
});
if (mode === "gone") {
	await decommissionMutation(key);
	throw new Error("decommission did not reach its second journal transition");
}
await acknowledgeMutation(key, "force-rebaseline");
throw new Error("acknowledgement did not reach archival");
