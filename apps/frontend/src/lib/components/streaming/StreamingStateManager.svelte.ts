/**
 * StreamingStateManager - Svelte 5 Runes Implementation
 *
 * Manages streaming-related state with reactive $state.
 * Subscribes to WebSocket messages and processes pipeline data.
 */
import { getLL, locale } from "@ceraui/i18n/svelte";


import {
	type GroupedPipelines,
	groupPipelinesByDeviceAndFormat,
} from "$lib/helpers/PipelineHelper";
import {
	AudioCodecsMessages,
	ConfigMessages,
	PipelinesMessages,
	RelaysMessages,
	StatusMessages,
} from "$lib/stores/websocket-store.svelte";
import type {
	AudioCodecsMessage,
	ConfigMessage,
	PipelinesMessage,
	RelayMessage,
} from "$lib/types/socket-messages";

export interface StreamingState {
	groupedPipelines: GroupedPipelines[keyof GroupedPipelines] | undefined;
	unparsedPipelines: PipelinesMessage | undefined;
	isStreaming: boolean | undefined;
	audioSources: Array<string>;
	audioCodecs: AudioCodecsMessage | undefined;
	relayMessage: RelayMessage | undefined;
	savedConfig: ConfigMessage | undefined;
	notAvailableAudioSource: string | undefined;
}

/**
 * StreamingStateManager using Svelte 5 runes ($state)
 *
 * State is reactive and can be accessed directly without subscriptions.
 */
class StreamingStateManager {
	// Svelte 5 reactive state
	private _groupedPipelines = $state<
		GroupedPipelines[keyof GroupedPipelines] | undefined
	>(undefined);
	private _unparsedPipelines = $state<PipelinesMessage | undefined>(undefined);
	private _isStreaming = $state<boolean | undefined>(undefined);
	private _audioSources = $state<Array<string>>([]);
	private _audioCodecs = $state<AudioCodecsMessage | undefined>(undefined);
	private _relayMessage = $state<RelayMessage | undefined>(undefined);
	private _savedConfig = $state<ConfigMessage | undefined>(undefined);
	private _notAvailableAudioSource = $state<string | undefined>(undefined);

	private _disposers: (() => void)[] = [];

	// Reactive getters - direct access to $state
	get groupedPipelines() {
		return this._groupedPipelines;
	}
	get unparsedPipelines() {
		return this._unparsedPipelines;
	}
	get isStreaming() {
		return this._isStreaming;
	}
	get audioSources() {
		return this._audioSources;
	}
	get audioCodecs() {
		return this._audioCodecs;
	}
	get relayMessage() {
		return this._relayMessage;
	}
	get savedConfig() {
		return this._savedConfig;
	}
	get notAvailableAudioSource() {
		return this._notAvailableAudioSource;
	}

	constructor() {
		this.setupSubscriptions();
		this.setupReactiveEffects();
	}

	public cleanup(): void {
		for (const dispose of this._disposers) {
			dispose();
		}
		this._disposers = [];
	}

	private setupSubscriptions() {
		// Subscribe to audio codecs messages
		const unsubAudio = AudioCodecsMessages.subscribe((audioCodecsMessage) => {
			if (audioCodecsMessage && !this._audioCodecs) {
				this._audioCodecs = audioCodecsMessage;
			}
		});
		this._disposers.push(unsubAudio);

		// Subscribe to status messages
		const unsubStatus = StatusMessages.subscribe((status) => {
			if (status) {
				if (this._isStreaming !== status.is_streaming) {
					this._isStreaming = status.is_streaming;
				}

				// Compare audio sources array content, not just length
				const audioSourcesChanged =
					!this._audioSources ||
					status.asrcs.length !== this._audioSources.length ||
					!status.asrcs.every(
						(src, index) => src === this._audioSources?.[index],
					);

				if (audioSourcesChanged) {
					this._audioSources = status.asrcs;

					// Re-evaluate audio source availability when the list is updated
					if (this._savedConfig?.asrc) {
						if (this._audioSources.includes(this._savedConfig.asrc)) {
							this._notAvailableAudioSource = undefined;
						} else {
							this._notAvailableAudioSource = this._savedConfig.asrc;
						}
					}
				}
			}
		});
		this._disposers.push(unsubStatus);

		// Subscribe to configuration messages
		const unsubConfig = ConfigMessages.subscribe((config) => {
			if (config && this._savedConfig !== config) {
				this._savedConfig = config;
			}
		});
		this._disposers.push(unsubConfig);

		// Subscribe to relay messages
		const unsubRelays = RelaysMessages.subscribe((message) => {
			if (this._relayMessage !== message) {
				this._relayMessage = message;
			}
		});
		this._disposers.push(unsubRelays);

		// Subscribe to pipeline messages
		const unsubPipelines = PipelinesMessages.subscribe((message) => {
			if (message) {
				this._unparsedPipelines = message;

				// Process pipelines immediately when they arrive
				this.processPipelines();
			}
		});
		this._disposers.push(unsubPipelines);
	}

	private setupReactiveEffects() {
		// Set up reactive pipeline processing using locale store subscription
		const unsubLocale = locale.subscribe(() => {
			// Process pipelines when locale changes (for translation updates)
			this.processPipelines();
		});
		this._disposers.push(unsubLocale);
	}

	// Extract pipeline processing logic into a separate method
	private processPipelines() {
		if (this._unparsedPipelines && getLL()) {
			const allGroupedPipelines = groupPipelinesByDeviceAndFormat(
				this._unparsedPipelines,
				{
					matchDeviceResolution: getLL().settings.matchDeviceResolution(),
					matchDeviceOutput: getLL().settings.matchDeviceOutput(),
				},
			);

			// Get the first available device dynamically
			const availableDevices = Object.keys(allGroupedPipelines);
			if (availableDevices.length > 0) {
				this._groupedPipelines = allGroupedPipelines[availableDevices[0]];
			} else {
				this._groupedPipelines = undefined;
			}
		}
	}

	// Get current state snapshot
	getState(): StreamingState {
		return {
			groupedPipelines: this._groupedPipelines,
			unparsedPipelines: this._unparsedPipelines,
			isStreaming: this._isStreaming,
			audioSources: this._audioSources,
			audioCodecs: this._audioCodecs,
			relayMessage: this._relayMessage,
			savedConfig: this._savedConfig,
			notAvailableAudioSource: this._notAvailableAudioSource,
		};
	}
}

export function createStreamingStateManager(): StreamingStateManager {
	return new StreamingStateManager();
}
