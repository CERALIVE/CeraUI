import type { SoftwareUpdateAttempt } from "../../modules/system/software-update-output.ts";
import type { DetachedAptUpgradeDeps } from "../../modules/system/software-update-process.ts";

/** A fixed systemd InvocationID for fake units; a real one is always present. */
export const TEST_INVOCATION = "abcdef0123456789abcdef0123456789";

/** A real `systemctl show` rendering as today's probe gets it: with the unit's InvocationID. */
export function withInvocation(show: string): string {
	return `${show.trimEnd()}\nInvocationID=${TEST_INVOCATION}\n`;
}

/** The attempt record in memory, as durable as the device's for the test's lifetime. */
export function memoryAttempt(): Pick<
	DetachedAptUpgradeDeps,
	"readAttempt" | "updateAttempt"
> & { readonly record: () => SoftwareUpdateAttempt | null } {
	let record: SoftwareUpdateAttempt | null = null;
	return {
		readAttempt: () => record,
		updateAttempt: (change) => {
			const next = change(record);
			if (next) record = next;
			return next;
		},
		record: () => record,
	};
}

/** What the real observer hands the monitor once a unit's exit is recorded and read: its claim. */
export function recordedClaim(completion: Promise<number> | number) {
	return async () => ({
		attempt: "11111111-1111-4111-8111-111111111111",
		exitCode: await completion,
		drained: true,
		plan: true,
	});
}
