/**
 * Streaming ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	audioCodecsMessageSchema,
	bitrateInputSchema,
	bitrateOutputSchema,
	configMessageSchema,
	getEngineOutputSchema,
	getMockHardwareOutputSchema,
	listDevicesOutputSchema,
	pipelinesSchema,
	reloadAudioDelayInputSchema,
	reloadAudioDelayOutputSchema,
	setMockDeviceAttachedInputSchema,
	setMockDeviceAttachedOutputSchema,
	setMockHardwareInputSchema,
	setMockHardwareOutputSchema,
	setSourceVisibilityInputSchema,
	setSourceVisibilityOutputSchema,
	streamHealthOutputSchema,
	streamingConfigInputSchema,
	streamingSetConfigOutputSchema,
	streamingStartOutputSchemaExtended,
	streamingStopOutputSchema,
	switchAudioInputSchema,
	switchAudioOutputSchema,
	switchInputInputSchema,
	switchInputOutputSchema,
} from '../schemas';

export const streamingContract = oc.router({
	/**
	 * Start streaming with configuration
	 */
	start: oc.input(streamingConfigInputSchema).output(streamingStartOutputSchemaExtended),

	/**
	 * Stop streaming
	 */
	stop: oc.output(streamingStopOutputSchema),

	/**
	 * Set bitrate during streaming
	 */
	setBitrate: oc.input(bitrateInputSchema).output(bitrateOutputSchema),

	/**
	 * Get available pipelines
	 */
	getPipelines: oc.output(pipelinesSchema),

	/**
	 * Get available audio codecs
	 */
	getAudioCodecs: oc.output(audioCodecsMessageSchema),

	/**
	 * Get current configuration
	 */
	getConfig: oc.output(configMessageSchema),

	/**
	 * Persist streaming/server configuration without starting the stream.
	 */
	setConfig: oc.input(streamingConfigInputSchema).output(streamingSetConfigOutputSchema),

	/**
	 * Persist device-wide source visibility (test-pattern hide) — config-only,
	 * rebroadcasts `sources` + `config`. The single mutation path for
	 * `sources_visibility`; never `setConfig`.
	 */
	setSourceVisibility: oc
		.input(setSourceVisibilityInputSchema)
		.output(setSourceVisibilityOutputSchema),

	/**
	 * Subscribe to streaming status changes
	 */
	onStatusChange: oc.route({ method: 'GET', path: '/streaming/status' }),

	/**
	 * Tri-state stream health (process + frame + SRT + bond liveness)
	 */
	streamHealth: oc.output(streamHealthOutputSchema),

	/**
	 * Set mock hardware override (dev-only)
	 * Changes the active hardware type and reloads pipelines
	 */
	setMockHardware: oc.input(setMockHardwareInputSchema).output(setMockHardwareOutputSchema),

	/**
	 * Detach/reattach one mock capture device by input_id (dev-only). Drives the
	 * single-device unplug/replug seam so e2e can exercise the lost-row grace state.
	 */
	setMockDeviceAttached: oc
		.input(setMockDeviceAttachedInputSchema)
		.output(setMockDeviceAttachedOutputSchema),

	/**
	 * Get current mock hardware state (dev-only)
	 */
	getMockHardware: oc.output(getMockHardwareOutputSchema),

	/**
	 * Which streaming engine the device runs (drives the picker conditional).
	 */
	getEngine: oc.output(getEngineOutputSchema),

	/**
	 * List the currently discovered input sources (hotplug-aware picker).
	 */
	listDevices: oc.output(listDevicesOutputSchema),

	/**
	 * Live-switch the active input; returns the glitch-free gap in ms.
	 */
	switchInput: oc.input(switchInputInputSchema).output(switchInputOutputSchema),

	/**
	 * Live-switch the active audio source (Phase 1.5). Gated on the engine's
	 * `audio_live_switch` capability; returns the glitch-free gap in ms.
	 */
	switchAudio: oc.input(switchAudioInputSchema).output(switchAudioOutputSchema),

	/**
	 * Hot-apply the audio delay (Phase 1.5) via reload-config — no stream restart.
	 */
	reloadAudioDelay: oc.input(reloadAudioDelayInputSchema).output(reloadAudioDelayOutputSchema),
});
