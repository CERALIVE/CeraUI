/**
 * Status Procedures
 * Provides aggregated status information
 */

import {
	modemListSchema,
	relayMessageSchema,
	statusResponseSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { getCellularStack } from "../../modules/cellular/cellular-stack.ts";
import { getConfig } from "../../modules/config.ts";
import { buildModemsWireMessage } from "../../modules/modems/modem-status.ts";
import { getNetworkIngestInfo } from "../../modules/network/network-ingest.ts";
import { netIfBuildMsg } from "../../modules/network/network-interfaces.ts";
import { getUnclaimedAdapters } from "../../modules/network/unclaimed-adapters.ts";
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
	getResolvedAsrcCandidates,
	getResolvedAsrcReason,
} from "../../modules/streaming/auto-audio.ts";
import { getLastCapabilities } from "../../modules/streaming/capabilities.ts";
import { getDevicesMessage } from "../../modules/streaming/devices.ts";
import { getEngineBitrateStatus } from "../../modules/streaming/engine-bitrate-status.ts";
import { buildBondMapping } from "../../modules/streaming/link-mapping-report.ts";
import { AUDIO_CODECS } from "../../modules/streaming/pipeline-sources.ts";
import { getPipelinesMessage } from "../../modules/streaming/pipelines.ts";
import { getPreviewEncoderRealizedStatus } from "../../modules/streaming/preview-encoder-status.ts";
import { getSourcesMessage } from "../../modules/streaming/sources.ts";
import { getStreamLifecycleState } from "../../modules/streaming/stream-lifecycle-status.ts";
import { getIsStreaming } from "../../modules/streaming/streaming.ts";
import { getCpuInfo } from "../../modules/system/cpu.ts";
import { getEncoderLoad } from "../../modules/system/encoder-load.ts";
import { getRevisions } from "../../modules/system/revisions.ts";
import { getSensors } from "../../modules/system/sensors.ts";
import {
	getAvailableUpdates,
	getSoftUpdateStatus,
	getUpdateState,
} from "../../modules/system/software-updates.ts";
import { getCachedSshStatus, getSshStatus } from "../../modules/system/ssh.ts";
import { getPersistentNotifications } from "../../modules/ui/notifications.ts";
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
 * `buildModemsWireMessage` and `netIfBuildMsg`. These builders read the legacy
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
			stream_lifecycle: getStreamLifecycleState(),
			available_updates: getAvailableUpdates(),
			updating: getSoftUpdateStatus(),
			update_state: getUpdateState(),
			ssh: getCachedSshStatus(),
			wifi: wifiBuildMsg(),
			modems: modemListSchema.parse(buildModemsWireMessage()),
			asrcs: Object.keys(getAudioDevices()),
			audio_sources: deriveAudioSources(),
			resolved_asrc: getResolvedAsrc(),
			resolved_asrc_reason: getResolvedAsrcReason(),
			resolved_asrc_candidates: getResolvedAsrcCandidates(),
			pending_audio_follow_asrc: getPendingAudioFollowAsrc(),
			bond_mapping: buildBondMapping(),
			network_ingest: getNetworkIngestInfo(),
			active_encode: getActiveEncodeStatus(),
			engine_bitrate: getEngineBitrateStatus(),
			preview_encoder_realized: getPreviewEncoderRealizedStatus(),
			cellular_initializing: !getCellularStack().ready,
			unclaimed_adapters: getUnclaimedAdapters(),
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
			stream_lifecycle: getStreamLifecycleState(),
			available_updates: getAvailableUpdates(),
			updating: getSoftUpdateStatus(),
			update_state: getUpdateState(),
			ssh: getCachedSshStatus(),
			wifi: wifiBuildMsg(),
			modems: modemListSchema.parse(buildModemsWireMessage()),
			asrcs: Object.keys(getAudioDevices()),
			audio_sources: deriveAudioSources(),
			resolved_asrc: getResolvedAsrc(),
			resolved_asrc_reason: getResolvedAsrcReason(),
			resolved_asrc_candidates: getResolvedAsrcCandidates(),
			pending_audio_follow_asrc: getPendingAudioFollowAsrc(),
			bond_mapping: buildBondMapping(),
			network_ingest: getNetworkIngestInfo(),
			active_encode: getActiveEncodeStatus(),
			engine_bitrate: getEngineBitrateStatus(),
			preview_encoder_realized: getPreviewEncoderRealizedStatus(),
			cellular_initializing: !getCellularStack().ready,
			unclaimed_adapters: getUnclaimedAdapters(),
		},
		netif: netIfBuildMsg(),
		sensors: getSensors(),
		encoderLoad: getEncoderLoad(),
		// A BOOT FACT with no periodic loop behind it, so the initial push is the
		// ONLY way a client ever learns the core count `cpuLoad1` is divided by.
		cpu: getCpuInfo(),
		revisions: getRevisions(),
		acodecs: AUDIO_CODECS,
		devices: getDevicesMessage(),
		sources: getSourcesMessage(),
		capabilities: getLastCapabilities(),
	};
}

/**
 * The persistent notification set, for the post-auth initial push.
 *
 * A notification raised ONCE at boot — the load-time encoder-mode clamp is the
 * only one today — fires strictly before any browser can be connected, so
 * without this replay it is stored, returned by `notifications.getPersistent`,
 * and never rendered: the panel reads the push cache. Every other persistent
 * notification is raised by a loop that re-evaluates, which is why the gap went
 * unnoticed until a board proof used a genuinely one-shot one.
 */
export function buildInitialNotifications() {
	return getPersistentNotifications(true);
}
