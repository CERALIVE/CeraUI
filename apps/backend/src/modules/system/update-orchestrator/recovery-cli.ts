import { RecoveryRefusal, recoverCrossSlot } from "./recovery.ts";
import {
	createRecoveryProbes,
	defaultRecoveryProbeIo,
} from "./recovery-probes.ts";
import { fileRecoveryStore, recoveryIdentitySchema } from "./recovery-store.ts";

const argv = process.argv.slice(2);
const names = [
	"--agent-sha256",
	"--plan-sha256",
	"--boot-id",
	"--slot",
	"--compatible",
	"--os-version",
] as const;
if (
	argv[0] !== "--locked" ||
	argv.length !== 13 ||
	names.some((name, index) => argv[1 + index * 2] !== name)
) {
	throw new RecoveryRefusal("expected_six_identity_arguments_under_lock");
}
const identity = recoveryIdentitySchema.parse({
	agentSha256: argv[2],
	planSha256: argv[4],
	bootId: argv[6],
	slot: argv[8],
	compatible: argv[10],
	osVersion: argv[12],
});
const probes = createRecoveryProbes(defaultRecoveryProbeIo);
if (!probes.root()) throw new RecoveryRefusal("root_required");
const outcome = await recoverCrossSlot(identity, {
	store: fileRecoveryStore(),
	probes,
	withLock: (operation) => operation(),
	now: Date.now,
});
process.stdout.write(`${outcome.kind}: ${outcome.receiptId}\n`);
