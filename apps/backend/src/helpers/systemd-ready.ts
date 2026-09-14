import { run } from "./run.ts";

/** Release After= dependants only once the control socket and signal guards exist. */
export async function notifyServiceReady(
	notifySocket: string | undefined = process.env.NODE_ENV === "production"
		? process.env.NOTIFY_SOCKET
		: undefined,
	runner: typeof run = run,
): Promise<void> {
	if (!notifySocket) return;
	// The root service may notify as its parent PID; keep NotifyAccess=main.
	// Do not use --no-block: wait for PID 1 to acknowledge before the helper exits.
	await runner(
		"/usr/bin/systemd-notify",
		[
			"--ready",
			"--pid=parent",
			"--status=Control server bound; boot signals reserved",
		],
		{ timeout: 5_000 },
	);
}
