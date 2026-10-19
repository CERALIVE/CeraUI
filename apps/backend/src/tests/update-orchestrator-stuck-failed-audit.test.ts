import { expect, test } from "bun:test";
import {
	packageRecoveryProven,
	readPackageConsistency,
} from "../modules/system/update-orchestrator/package-recovery-evidence.ts";
import type { RecoveryProbeIo } from "../modules/system/update-orchestrator/recovery-probes.ts";
import { defaultRecoveryProbeIo } from "../modules/system/update-orchestrator/recovery-probes.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

// Raw dpkg --audit from the Orange Pi power-cut capture; exit zero is not clean.
const dirty = `The following packages are in a mess due to serious problems during
installation.  They must be reinstalled for them (and any packages
that depend on them) to function properly:
 curl                 command line tool for transferring data with URL syntax
`;
const absent =
	"LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=0\n";

for (const audit of [
	{
		name: "dirty stdout at exit zero",
		code: 0,
		stdout: dirty,
		stderr: "",
		permits: false,
	},
	{
		name: "failed silent audit",
		code: 2,
		stdout: "",
		stderr: "",
		permits: false,
	},
	{
		name: "stderr-only diagnostic at exit zero",
		code: 0,
		stdout: "",
		stderr: "dpkg: warning: database diagnostic\n",
		permits: false,
	},
	{
		name: "whitespace stderr at exit zero",
		code: 0,
		stdout: "",
		stderr: "\n",
		permits: false,
	},
	{
		name: "silent successful audit",
		code: 0,
		stdout: "",
		stderr: "",
		permits: true,
	},
]) {
	test(`collector-to-decision recovery with ${audit.name}`, async () => {
		// Given a recorded previous-boot failure and raw command results.
		const before = {
			...initialOrchestratorState(100),
			phase: "failed" as const,
			failureReason: "commit_unit_absent_on_resume",
			packageAttempt: { bootId: "previous", slot: "rootfs.1" },
		};
		const io: RecoveryProbeIo = {
			run: async (argv) => {
				switch (argv[0]) {
					case "dpkg":
						return audit;
					case "systemctl":
						return { code: 0, stdout: absent, stderr: "" };
					case "busctl":
						return { code: 0, stdout: 's "idle"', stderr: "" };
					default:
						throw new TypeError("unexpected audit fixture command");
				}
			},
			read: async () => "sleep\n",
			list: async (path) => (path === "/proc" ? ["123"] : []),
		};
		// When the real collector feeds the real recovery decision.
		const consistency = await readPackageConsistency(io, async () => true);
		const recovered = packageRecoveryProven(before, {
			...consistency,
			bootId: "current",
			slot: "rootfs.0",
		});
		// Then only a silent, successful audit permits the consistency transition.
		expect(recovered).toBe(audit.permits);
	});
}

test("production command adapter retains successful stderr diagnostics", async () => {
	// Given a real successful command with diagnostic output only.
	// When the default command adapter captures it.
	const result = await defaultRecoveryProbeIo.run([
		process.execPath,
		"-e",
		'process.stderr.write("audit diagnostic\\n")',
	]);
	// Then the collector receives stderr instead of silently losing it.
	expect(result).toEqual({ code: 0, stdout: "", stderr: "audit diagnostic\n" });
});
