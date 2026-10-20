import type { spawnWithTimeout } from "../../helpers/spawn-policy.ts";
import type { RaucEscalationScheduler } from "../../modules/system/update-orchestrator/stream-abort.ts";

export const okCommand = { exitCode: 0, stdout: "", stderr: "" };
export const stoppingRauc =
	"ActiveState=deactivating\nMainPID=123\nInvocationID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";

export function raucEscalationFixture() {
	let time = 0;
	let sequence = 0;
	const tasks = new Map<number, { at: number; task: () => Promise<void> }>();
	const commands: string[][] = [];
	const options: Parameters<typeof spawnWithTimeout>[1][] = [];
	let reply: typeof spawnWithTimeout = async (argv) => ({
		...okCommand,
		stdout: argv.includes("show") ? stoppingRauc : "",
	});
	const scheduler = {
		now: () => time,
		schedule: (task: () => Promise<void>, delayMs: number) => {
			const id = ++sequence;
			tasks.set(id, { at: time + delayMs, task });
			return () => {
				tasks.delete(id);
			};
		},
	} satisfies RaucEscalationScheduler;
	return {
		scheduler,
		commands,
		options,
		pending: () => tasks.size,
		setReply: (next: typeof spawnWithTimeout) => {
			reply = next;
		},
		run: (async (argv, opts) => {
			commands.push(argv);
			options.push(opts);
			return reply(argv, opts);
		}) satisfies typeof spawnWithTimeout,
		advance: async (until: number) => {
			for (;;) {
				const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > until) break;
				time = next[1].at;
				tasks.delete(next[0]);
				await next[1].task();
			}
			time = Math.max(time, until);
		},
	};
}
