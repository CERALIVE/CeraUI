import { LL, locale } from "@ceraui/i18n/svelte";
import { get, writable } from "svelte/store";

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
} from "$lib/stores/websocket-store";
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

class StreamingStateManager {
	// Create reactive stores for each property
	private _groupedPipelinesStore = writable<
		GroupedPipelines[keyof GroupedPipelines] | undefined
	>(undefined);
	private _unparsedPipelinesStore = writable<PipelinesMessage | undefined>(
		undefined,
	);
	private _isStreamingStore = writable<boolean | undefined>(undefined);
	private _audioSourcesStore = writable<Array<string>>([]);
	private _audioCodecsStore = writable<AudioCodecsMessage | undefined>(
		undefined,
	);
	private _relayMessageStore = writable<RelayMessage | undefined>(undefined);
	private _savedConfigStore = writable<ConfigMessage | undefined>(undefined);
	private _notAvailableAudioSourceStore = writable<string | undefined>(
		undefined,
	);

	// Internal values for immediate access
	private _groupedPipelines:
		| GroupedPipelines[keyof GroupedPipelines]
		| undefined = undefined;
	private _unparsedPipelines: PipelinesMessage | undefined = undefined;
	private _isStreaming: boolean | undefined = undefined;
	private _audioSources: Array<string> = [];
	private _audioCodecs: AudioCodecsMessage | undefined = undefined;
	private _relayMessage: RelayMessage | undefined = undefined;
	private _savedConfig: ConfigMessage | undefined = undefined;
	private _notAvailableAudioSource: string | undefined = undefined;

	// Reactive getters that return store values for Svelte reactivity
	get groupedPipelines() {
		return get(this._groupedPipelinesStore);
	}
	get unparsedPipelines() {
		return get(this._unparsedPipelinesStore);
	}
	get isStreaming() {
		return get(this._isStreamingStore);
	}
	get audioSources() {
		return get(this._audioSourcesStore);
	}
	get audioCodecs() {
		return get(this._audioCodecsStore);
	}
	get relayMessage() {
		return get(this._relayMessageStore);
	}
	get savedConfig() {
		return get(this._savedConfigStore);
	}
	get notAvailableAudioSource() {
		return get(this._notAvailableAudioSourceStore);
	}

	// Store access for reactive components that need to subscribe
	get groupedPipelinesStore() {
		return this._groupedPipelinesStore;
	}
	get unparsedPipelinesStore() {
		return this._unparsedPipelinesStore;
	}
	get isStreamingStore() {
		return this._isStreamingStore;
	}
	get audioSourcesStore() {
		return this._audioSourcesStore;
	}
	get audioCodecsStore() {
		return this._audioCodecsStore;
	}
	get relayMessageStore() {
		return this._relayMessageStore;
	}
	get savedConfigStore() {
		return this._savedConfigStore;
	}
	get notAvailableAudioSourceStore() {
		return this._notAvailableAudioSourceStore;
	}

	private _disposers: (() => void)[] = [];

	constructor() {
		this.setupSubscriptions();
		this.setupReactiveEffects();
	}

	public cleanup(): void {
		this._disposers.forEach((dispose) => dispose());
		this._disposers = [];
	}

	private updateStores() {
		console.log(`[StreamingStateManager] Updating stores:`, {
			hasGroupedPipelines: !!this._groupedPipelines,
			groupedPipelinesKeys: this._groupedPipelines
				? Object.keys(this._groupedPipelines)
				: "undefined",
			hasUnparsedPipelines: !!this._unparsedPipelines,
			timestamp: new Date().toISOString(),
		});

		// Only update stores if values have actually changed to prevent unnecessary reactive updates
		this._groupedPipelinesStore.set(this._groupedPipelines);
		this._unparsedPipelinesStore.set(this._unparsedPipelines);
		this._isStreamingStore.set(this._isStreaming);
		this._audioSourcesStore.set(this._audioSources);
		this._audioCodecsStore.set(this._audioCodecs);
		this._relayMessageStore.set(this._relayMessage);
		this._savedConfigStore.set(this._savedConfig);
		this._notAvailableAudioSourceStore.set(this._notAvailableAudioSource);
	}

	private setupSubscriptions() {
		// WebSocket subscriptions
		AudioCodecsMessages.subscribe((audioCodecsMessage) => {
			if (audioCodecsMessage && !this._audioCodecs) {
				this._audioCodecs = audioCodecsMessage;
				this.updateStores();
			}
		});

		StatusMessages.subscribe((status) => {
			if (status) {
				let hasChanged = false;

				if (this._isStreaming !== status.is_streaming) {
					this._isStreaming = status.is_streaming;
					hasChanged = true;
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
					hasChanged = true;

					// Re-evaluate audio source availability when the list is updated
					if (this._savedConfig?.asrc) {
						if (this._audioSources.includes(this._savedConfig.asrc)) {
							this._notAvailableAudioSource = undefined;
						} else {
							this._notAvailableAudioSource = this._savedConfig.asrc;
						}
					}
				}

				// Only update stores if something actually changed
				if (hasChanged) {
					this.updateStores();
				}
			}
		});

		// Subscribe to configuration messages
		ConfigMessages.subscribe((config) => {
			if (config && this._savedConfig !== config) {
				this._savedConfig = config;
				this.updateStores();
			}
		});

		RelaysMessages.subscribe((message) => {
			if (this._relayMessage !== message) {
				this._relayMessage = message;
				this.updateStores();
			}
		});

		// Subscribe to pipeline messages
		PipelinesMessages.subscribe((message) => {
			if (message) {
				this._unparsedPipelines = message;
				this.updateStores();

				// Debug: Log pipeline structure to understand device types
				console.debug(
					"Pipeline message received:",
					Object.keys(message).length,
					"pipelines",
				);
				const samplePipelines = Object.entries(message).slice(0, 3);
				console.debug(
					"Sample pipeline names:",
					samplePipelines.map(([_key, value]) => value.name),
				);

				// Process pipelines immediately when they arrive (don't wait for locale changes)
				this.processPipelines();
			}
		});
	}

	private setupReactiveEffects() {
		// Set up reactive pipeline processing using locale store subscription
		locale.subscribe((currentLocale) => {
			console.log(
				`[StreamingStateManager] Locale changed, processing pipelines:`,
				{
					hasUnparsedPipelines: !!this._unparsedPipelines,
					locale: currentLocale,
					timestamp: new Date().toISOString(),
				},
			);

			// Process pipelines when locale changes (for translation updates)
			this.processPipelines();
		});
	}

	// Extract pipeline processing logic into a separate method
	private processPipelines() {
		if (this._unparsedPipelines && get(LL)) {
			console.log(`[StreamingStateManager] Processing pipelines`);

			const allGroupedPipelines = groupPipelinesByDeviceAndFormat(
				this._unparsedPipelines,
				{
					matchDeviceResolution: get(LL).settings.matchDeviceResolution(),
					matchDeviceOutput: get(LL).settings.matchDeviceOutput(),
				},
			);

			// Get the first available device dynamically
			const availableDevices = Object.keys(allGroupedPipelines);
			if (availableDevices.length > 0) {
				console.log(`[StreamingStateManager] Setting grouped pipelines:`, {
					availableDevices,
					selectedDevice: availableDevices[0],
					timestamp: new Date().toISOString(),
				});

				this._groupedPipelines = allGroupedPipelines[availableDevices[0]];
				this.updateStores();

				// Log for debugging what devices are available
				if (availableDevices.length > 1) {
					console.info(
						"Multiple devices available:",
						availableDevices,
						"Using:",
						availableDevices[0],
					);
				}
			} else {
				console.warn("No devices found in pipeline data");
				this._groupedPipelines = undefined;
				this.updateStores();
			}
		} else {
			console.log(
				`[StreamingStateManager] Cannot process pipelines - missing data:`,
				{
					hasUnparsedPipelines: !!this._unparsedPipelines,
					hasTranslations: !!get(LL),
					timestamp: new Date().toISOString(),
				},
			);
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
