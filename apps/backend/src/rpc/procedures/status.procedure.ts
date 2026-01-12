/**
 * Status Procedures
 * Provides aggregated status information
 */

import { relayMessageSchema, statusResponseSchema } from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";

import { getConfig } from "../../modules/config.ts";
import { buildModemsMessage } from "../../modules/modems/modem-status.ts";
import { netIfBuildMsg } from "../../modules/network/network-interfaces.ts";
import {
	buildRelaysMsg,
	getRelays,
} from "../../modules/remote/remote-relays.ts";
import { getAudioDevices } from "../../modules/streaming/audio.ts";
import { AUDIO_CODECS } from "@ceralive/ceracoder";
import { getPipelinesMessage } from "../../modules/streaming/pipelines.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import { getRevisions } from "../../modules/system/revisions.ts";
import { getSensors } from "../../modules/system/sensors.ts";
import {
	getAvailableUpdates,
	getSoftUpdateStatus,
} from "../../modules/system/software-updates.ts";
import { getSshStatus } from "../../modules/system/ssh.ts";
import { wifiBuildMsg } from "../../modules/wifi/wifi.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Get full status procedure
 */
export const getStatusProcedure = authedProcedure
	.output(statusResponseSchema)
	.handler(() => {
		return {
			is_streaming: getIsStreaming(),
			available_updates: getAvailableUpdates(),
			updating: getSoftUpdateStatus(),
			ssh: getSshStatus(),
			wifi: wifiBuildMsg(),
			modems: buildModemsMessage(),
			asrcs: Object.keys(getAudioDevices()),
		};
	});

/**
 * Get relays procedure
 */
export const getRelaysProcedure = authedProcedure
	.output(relayMessageSchema.nullable())
	.handler(() => {
		const relays = getRelays();
		if (relays) {
			return buildRelaysMsg();
		}
		return null;
	});

/**
 * Build initial status message for new connections
 */
export function buildInitialStatus() {
	const config = getConfig();
	return {
		config,
		pipelines: getPipelinesMessage(),
		relays: getRelays() ? buildRelaysMsg() : null,
		status: {
			is_streaming: getIsStreaming(),
			available_updates: getAvailableUpdates(),
			updating: getSoftUpdateStatus(),
			ssh: getSshStatus(),
			wifi: wifiBuildMsg(),
			modems: buildModemsMessage(),
			asrcs: Object.keys(getAudioDevices()),
		},
		netif: netIfBuildMsg(),
		sensors: getSensors(),
		revisions: getRevisions(),
		acodecs: AUDIO_CODECS,
	};
}
