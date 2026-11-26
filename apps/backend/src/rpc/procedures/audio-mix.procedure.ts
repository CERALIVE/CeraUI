import { CerastreamRpcError } from "@ceralive/cerastream";
import { rpcErrorSchema } from "@ceralive/cerastream/dist/envelope.js";
import {
	setAudioMixInputSchema,
	setAudioMixOutputSchema,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { setMockAudioMix } from "../../mocks/providers/streaming.ts";
import { getConfig, saveConfig } from "../../modules/config.ts";
import {
	changedAudioInputs,
	effectiveAudioInputs,
	primaryAudioInputId,
	storedAudioInputs,
	validateAudioInputs,
	validateAudioInputValues,
} from "../../modules/streaming/audio-inputs.ts";
import {
	getAudioMixActive,
	getAudioMixInputs,
} from "../../modules/streaming/audio-mix-status.ts";
import { cerastreamBackend } from "../../modules/streaming/cerastream-backend.ts";
import { noteAudioSaved } from "../../modules/streaming/start-audio.ts";
import { broadcastConfig } from "../config-broadcast.ts";
import { authMiddleware } from "../middleware/auth.middleware.ts";
import { uiBuildMiddleware } from "../middleware/ui-build.middleware.ts";
import type { RPCContext } from "../types.ts";

export const setAudioMixProcedure = os
	.$context<RPCContext>()
	.use(authMiddleware)
	.use(uiBuildMiddleware)
	.input(setAudioMixInputSchema)
	.output(setAudioMixOutputSchema)
	.handler(async ({ input: { id, include, track, ...update } }) => {
		const config = getConfig();
		// Composed and written in this synchronous stretch, so edits serialize.
		if (include !== undefined || track !== undefined) {
			const changed = changedAudioInputs(config, id, { include, track });
			if ("error" in changed) return { success: false, error: changed.error };
			config.audio_inputs = storedAudioInputs(changed.inputs, config);
			noteAudioSaved("audio_inputs");
			saveConfig();
			broadcastConfig(config);
			const entry = changed.inputs.find((input) => input.id === id);
			return {
				success: true,
				applies_next_start: true,
				...(entry === undefined
					? {}
					: {
							applied: {
								id,
								gain_db: entry.gain_db,
								mute: entry.mute,
								delay_ms: entry.delay_ms,
							},
						}),
			};
		}
		const live = getAudioMixActive();
		const running = getAudioMixInputs()?.find((input) => input.id === id);
		const primary = primaryAudioInputId(config);
		const saved =
			effectiveAudioInputs(config) ??
			(primary === undefined
				? []
				: [
						{
							id: primary,
							tracks: [1],
							gain_db: 0,
							mute: false,
							delay_ms: 0,
						},
					]);
		const selected = live ? running : saved.find((input) => input.id === id);
		if (!selected) return { success: false, error: "audio_input_unknown" };
		let applied = {
			id,
			gain_db: update.gain_db ?? selected.gain_db ?? 0,
			mute: update.mute ?? selected.mute ?? false,
			delay_ms: update.delay_ms ?? selected.delay_ms ?? 0,
		};
		const error = validateAudioInputValues(applied);
		if (error !== undefined) return { success: false, error };
		if (live && running) {
			const params = { inputs: [{ input_id: running.input_id, ...update }] };
			try {
				const result = shouldUseMocks()
					? setMockAudioMix(params)
					: await cerastreamBackend.setAudioMix(params);
				const state = result.inputs.find(
					(input) => input.input_id === running.input_id,
				);
				if (!state)
					throw new Error(
						"set-audio-mix returned no state for the requested input",
					);
				applied = {
					id,
					gain_db: state.gain_db,
					mute: state.mute,
					delay_ms: state.delay_ms,
				};
			} catch (error) {
				if (!(error instanceof CerastreamRpcError)) throw error;
				return {
					success: false,
					error: error.dataCode,
					engine_error: rpcErrorSchema.shape.error.parse({
						code: error.code,
						message: error.message,
						...(error.data === undefined ? {} : { data: error.data }),
					}),
				};
			}
		}
		const next = (live ? (effectiveAudioInputs(getConfig()) ?? []) : saved).map(
			(input) => (input.id === id ? { ...input, ...applied } : input),
		);
		if (!live) {
			const error = validateAudioInputs(next, config);
			if (error !== undefined) return { success: false, error };
		}
		// A pending membership/track edit stays pending; a live write changes values only.
		if (!live || config.audio_inputs !== undefined) {
			config.audio_inputs = storedAudioInputs(next, config);
			noteAudioSaved("audio_inputs");
			saveConfig();
			broadcastConfig(config);
		}
		return { success: true, applied, applies_next_start: !live };
	});
