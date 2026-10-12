import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../../helpers/config-schemas.ts";
import {
	buildAutoLaunchConfig,
	resolveAutoAsrcFromLiveState,
	setResolvedAsrcFromStart,
} from "../auto-audio.ts";

// "Auto" resolves at launch in a shallow copy; persisted config keeps its sentinel.
export function resolveLaunchConfig(config: RuntimeConfig): RuntimeConfig {
	if (config.asrc !== AUDIO_SOURCE_AUTO) return config;
	const resolution = resolveAutoAsrcFromLiveState();
	setResolvedAsrcFromStart(
		resolution.asrcKey,
		resolution.reason,
		resolution.candidates,
	);
	return buildAutoLaunchConfig(config, resolution);
}
