import { queryEngineRuntimeStreaming } from "../engine-runtime-state.ts";
import type { StreamingBackend } from "../streaming-backend.ts";
import { getStreamingBackend } from "../streaming-engine.ts";

export type StopEvidenceOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: unknown };

export function confirmUnownedEngineStop(
	finish: (outcome: StopEvidenceOutcome) => Promise<void>,
	deps: {
		readonly query: typeof queryEngineRuntimeStreaming;
		readonly stop: StreamingBackend["stop"];
		readonly confirmStop?: StreamingBackend["confirmStop"];
	} = {
		query: queryEngineRuntimeStreaming,
		stop: (...args) => getStreamingBackend().stop(...args),
		confirmStop: () => {
			const backend = getStreamingBackend();
			return backend.confirmStop === undefined
				? Promise.reject(new Error("engine_stop_unknown"))
				: backend.confirmStop();
		},
	},
	confirmUnknown = false,
): void {
	const fail = (error: unknown) => {
		void finish({ ok: false, error });
	};
	void deps.query().then((runtime) => {
		switch (runtime) {
			case "idle":
				void finish({ ok: true });
				break;
			case "streaming":
				if (
					!deps.stop(() => {
						void finish({ ok: true });
					}, fail)
				)
					fail(new Error("engine_stop_unknown"));
				break;
			case "unknown":
				if (!confirmUnknown || deps.confirmStop === undefined)
					fail(new Error("engine_stop_unknown"));
				else void deps.confirmStop().then(() => finish({ ok: true }), fail);
				break;
		}
	}, fail);
}
