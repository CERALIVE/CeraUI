import { AsyncLocalStorage } from "node:async_hooks";
import { StreamStartFailure } from "./start-failure-taxonomy.ts";
import type { StreamLaunchContext } from "./stream-session-orchestrator.ts";

const launches = new AsyncLocalStorage<StreamLaunchContext>();

export function withStreamLaunchOwnership(
	context: StreamLaunchContext,
	launch: () => Promise<void>,
): Promise<void> {
	return launches.run(context, () => {
		try {
			return launch();
		} catch (error) {
			return Promise.reject(error);
		}
	});
}

export function currentStreamLaunchOwner(): () => boolean {
	const context = launches.getStore();
	return () => context === undefined || !context.cancelled();
}

export function assertStreamLaunchOwnership(): void {
	const context = launches.getStore();
	if (context?.cancelled())
		throw new StreamStartFailure({
			attemptId: context.attemptId,
			phase: "params",
			class: "start_invalid",
			code: "cancelled_launch",
			retriable: false,
		});
}
