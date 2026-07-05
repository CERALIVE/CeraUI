/**
 * Status Procedures
 * Provides aggregated status information
 */

import { relayMessageSchema, statusResponseSchema } from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { getConfig } from "../../modules/config.ts";
import { buildModemsMessage } from "../../modules/modems/modem-status.ts";
import { getNetworkIngestInfo } from "../../modules/network/network-ingest.ts";
import { netIfBuildMsg } from "../../modules/network/network-interfaces.ts";
import {
	buildRelaysMsg,
	getRelays,
} from "../../modules/remote/remote-relays.ts";
import { getActiveEncodeStatus } from "../../modules/streaming/active-encode-status.ts";
import {
	deriveAudioSources,
	getAudioDevices,
} from "../../modules/streaming/audio.ts";
import {
	getPendingAudioFollowAsrc,
	getResolvedAsrc,
	getResolvedAsrcReason,
} from "../../modules/streaming/auto-audio.ts";
import { getLastCapabilities } from "../../modules/streaming/capabilities.ts";
import { getDevicesMessage } from "../../modules/streaming/devices.ts";
import { AUDIO_CODECS } from "../../modules/streaming/pipeline-sources.ts";
import { getPipelinesMessage } from "../../modules/streaming/pipelines.ts";
import { getSourcesMessage } from "../../modules/streaming/sources.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import { getRevisions } from "../../modules/system/revisions.ts";
import { getSensors } from "../../modules/system/sensors.ts";
import {
	getAvailableUpdates,
	getSoftUpdateStatus,
} from "../../modules/system/software-updates.ts";
import { getCachedSshStatus, getSshStatus } from "../../modules/system/ssh.ts";
import { wifiBuildMsg } from "../../modules/wifi/wifi.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import type { RPCContext } from "../types.ts";

// Base procedure with context
const baseProcedure = os.$context<RPCContext>();

// Authenticated procedure
const authedProcedure = baseProcedure.use(authMiddleware);

/**
 * Get full status procedure
 *
 * The wifi/modems/netif snapshots are produced by `wifiBuildMsg`,
 * `buildModemsMessage` and `netIfBuildMsg`. These builders read the legacy
 * source-of-truth maps that the synchronized state caches (getNetifState /
 * getWifiState / getModemsState, T9/T10/T11) are kept in step with by the
 * event-driven loops (T14/T15/T17), so the snapshot reflects the synchronized
 * state while keeping the exact, frozen wire shapes.
 */
export const getStatusProcedure = authedProcedure
	.output(statusResponseSchema)
	.handler(() => {
		void getSshStatus();
		return {
			is_streaming: getIsStreaming(),
			available_updates: getAvailableUpdates(),
			updating: getSoftUpdateStatus(),
			ssh: getCachedSshStatus(),
			wifi: wifiBuildMsg(),
			modems: buildModemsMessage(),
			asrcs: Object.keys(getAudioDevices()),
			audio_sources: deriveAudioSources(),
			resolved_asrc: getResolvedAsrc(),
			resolved_asrc_reason: getResolvedAsrcReason(),
			pending_audio_follow_asrc: getPendingAudioFollowAsrc(),
			network_ingest: getNetworkIngestInfo(),
			active_encode: getActiveEncodeStatus(),
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
	void getSshStatus();
	return {
		config,
		pipelines: getPipelinesMessage(),
		relays: getRelays() ? buildRelaysMsg() : null,
		status: {
			is_streaming: getIsStreaming(),
			available_updates: getAvailableUpdates(),
			updating: getSoftUpdateStatus(),
			ssh: getCachedSshStatus(),
			wifi: wifiBuildMsg(),
			modems: buildModemsMessage(),
			asrcs: Object.keys(getAudioDevices()),
			audio_sources: deriveAudioSources(),
			resolved_asrc: getResolvedAsrc(),
			resolved_asrc_reason: getResolvedAsrcReason(),
			pending_audio_follow_asrc: getPendingAudioFollowAsrc(),
			network_ingest: getNetworkIngestInfo(),
			active_encode: getActiveEncodeStatus(),
		},
		netif: netIfBuildMsg(),
		sensors: getSensors(),
		revisions: getRevisions(),
		acodecs: AUDIO_CODECS,
		devices: getDevicesMessage(),
		sources: getSourcesMessage(),
		capabilities: getLastCapabilities(),
	};
}
