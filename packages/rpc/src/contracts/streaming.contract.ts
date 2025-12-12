/**
 * Streaming ORPC Contract
 */
import { oc } from '@orpc/contract';

import {
	audioCodecsMessageSchema,
	bitrateInputSchema,
	bitrateOutputSchema,
	configMessageSchema,
	getMockHardwareOutputSchema,
	pipelinesSchema,
	setMockHardwareInputSchema,
	setMockHardwareOutputSchema,
	streamingConfigInputSchema,
	streamingStartOutputSchema,
	streamingStopOutputSchema,
} from '../schemas';

export const streamingContract = oc.router({
	/**
	 * Start streaming with configuration
	 */
	start: oc.input(streamingConfigInputSchema).output(streamingStartOutputSchema),

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
	 * Subscribe to streaming status changes
	 */
	onStatusChange: oc.route({ method: 'GET', path: '/streaming/status' }),

	/**
	 * Set mock hardware override (dev-only)
	 * Changes the active hardware type and reloads pipelines
	 */
	setMockHardware: oc.input(setMockHardwareInputSchema).output(setMockHardwareOutputSchema),

	/**
	 * Get current mock hardware state (dev-only)
	 */
	getMockHardware: oc.output(getMockHardwareOutputSchema),
});
