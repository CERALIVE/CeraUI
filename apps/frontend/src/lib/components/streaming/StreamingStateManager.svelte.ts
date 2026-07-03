/**
 * StreamingStateManager - Svelte 5 Runes Implementation
 *
 * Reactive projection of the subscription-store snapshot into the streaming
 * surface. `$derived` fields track the canonical `subscriptions.svelte`
 * getters so every read is authoritative (single ingestion path); there is
 * no local `$state` fan-out and no imperative subscribe loop.
 */
import type {
	AudioCodecsMessage,
	ConfigMessage,
	HardwareType,
	Pipelines,
	RelayMessage,
} from "@ceraui/rpc/schemas";

import {
	getAudioCodecs,
	getConfig,
	getIsStreaming,
	getPipelines,
	getRelays,
	getStatus,
} from "$lib/rpc/subscriptions.svelte";

export interface StreamingState {
	pipelines: Pipelines | undefined;
	hardware: HardwareType | undefined;
	isStreaming: boolean | undefined;
	audioSources: Array<string>;
	audioCodecs: AudioCodecsMessage | undefined;
	relayMessage: RelayMessage | undefined;
	savedConfig: ConfigMessage | undefined;
	notAvailableAudioSource: string | undefined;
}

/**
 * StreamingStateManager reads reactively from the subscription store
 * (`$lib/rpc/subscriptions.svelte`). All fields are `$derived` — no local
 * `$state`, no `.subscribe()` fan-out, no cleanup semantics to manage.
 */
class StreamingStateManager {
	readonly pipelines = $derived<Pipelines | undefined>(
		getPipelines()?.pipelines as Pipelines | undefined,
	);
	readonly hardware = $derived<HardwareType | undefined>(
		getPipelines()?.hardware as HardwareType | undefined,
	);
	readonly isStreaming = $derived<boolean | undefined>(getIsStreaming());
	readonly audioSources = $derived<Array<string>>(getStatus()?.asrcs ?? []);
	readonly audioCodecs = $derived<AudioCodecsMessage | undefined>(
		getAudioCodecs() as AudioCodecsMessage | undefined,
	);
	readonly relayMessage = $derived<RelayMessage | undefined>(getRelays());
	readonly savedConfig = $derived<ConfigMessage | undefined>(getConfig());
	readonly notAvailableAudioSource = $derived.by<string | undefined>(() => {
		const asrc = getConfig()?.asrc;
		const asrcs = getStatus()?.asrcs;
		if (!asrc || !asrcs) return undefined;
		return asrcs.includes(asrc) ? undefined : asrc;
	});

	/**
	 * Kept for API compatibility with the pre-migration `.subscribe()` shape.
	 * `$derived` fields tear down with the instance — no manual disposers.
	 */
	cleanup(): void {
		// Intentionally empty — $derived fields tear down with the instance.
	}

	getState(): StreamingState {
		return {
			pipelines: this.pipelines,
			hardware: this.hardware,
			isStreaming: this.isStreaming,
			audioSources: this.audioSources,
			audioCodecs: this.audioCodecs,
			relayMessage: this.relayMessage,
			savedConfig: this.savedConfig,
			notAvailableAudioSource: this.notAvailableAudioSource,
		};
	}
}

export function createStreamingStateManager(): StreamingStateManager {
	return new StreamingStateManager();
}
