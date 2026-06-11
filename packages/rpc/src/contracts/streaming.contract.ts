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
	setMockHardwareInputSchema,
	setMockHardwareOutputSchema,
	streamHealthOutputSchema,
	streamingConfigInputSchema,
	streamingSetConfigOutputSchema,
	streamingStartOutputSchemaExtended,
	streamingStopOutputSchema,
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
});
