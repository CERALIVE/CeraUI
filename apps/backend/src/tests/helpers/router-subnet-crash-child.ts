import { setMutationJournalDeps } from "../../modules/modems/mutation-journal.ts";
import { withJournaledModemMutation } from "../../modules/modems/mutation-lease.ts";
import type { SubnetRewritePlan } from "../../modules/network/router-subnet-hygiene.ts";
import { preStateFor } from "../../modules/network/router-subnet-rollback.ts";

const [dir, state, encoded] = process.argv.slice(2);
if (!dir || !encoded || (state !== "armed" && state !== "executing"))
	throw new Error("crash fixture needs a private journal and crash point");
const { plan, netdev }: { plan: SubnetRewritePlan; netdev: unknown } =
	JSON.parse(encoded);
setMutationJournalDeps({ dir });
await withJournaledModemMutation(
	"usb:a",
	"router-subnet",
	{ ...preStateFor(plan), netdev },
	async (mutation) => {
		if (state === "executing") await mutation.markExecuting();
		process.kill(process.pid, "SIGKILL");
		return { confirmed: false, value: undefined };
	},
);
throw new Error("crash point was not reached");
