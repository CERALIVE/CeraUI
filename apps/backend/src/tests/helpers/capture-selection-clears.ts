import { expect, onTestFinished } from "bun:test";
import {
	CAPTURE_SELECTION_CLEAR_FEATURE,
	type ChangeConfigParams,
	type ChangeConfigResult,
	changeConfigParamsSchema,
} from "@ceralive/cerastream";
import { getConfig } from "../../modules/config.ts";
import { getCapabilities } from "../../modules/streaming/capabilities.ts";
import { cerastreamBackend } from "../../modules/streaming/cerastream-backend.ts";
import { changeEngineRuntimeConfig } from "../../modules/streaming/config-change-bridge.ts";
import { sourceSelectionFixture } from "./applied-source-selection.ts";

/** Real procedure, source builder, admission, bridge and file writer. Only the
 * engine reply is supplied at the existing backend changeConfig boundary. */
export async function captureSelectionFixture() {
	const f = await sourceSelectionFixture(changeEngineRuntimeConfig);
	const original = cerastreamBackend.changeConfig;
	onTestFinished(() => {
		cerastreamBackend.changeConfig = original;
	});
	const wire: ChangeConfigParams[] = [];
	let answer = async (): Promise<ChangeConfigResult> => ({
		attempt_id: "engine-selection",
		phase: "applied",
		state: "streaming",
	});
	cerastreamBackend.changeConfig = async (params) => {
		// The producer owns the wire shape; a hand-built nullable lookalike fails.
		expect(changeConfigParamsSchema.parse(params)).toEqual(params);
		wire.push(params);
		return answer();
	};
	const negotiate = (features: string[] | undefined) =>
		getCapabilities({
			fetchEngineCapabilities: async () => ({
				...f.capabilities,
				caps: { ...f.capabilities.caps, features },
			}),
			fetchEngineDevices: async () => ({ devices: [] }),
		});
	await negotiate([CAPTURE_SELECTION_CLEAR_FEATURE]);
	f.networkIngest.rtmp = {
		service_active: true,
		url: "rtmp://127.0.0.1:1935/publish/live",
	};
	f.networkIngest.srt = {
		service_active: true,
		url: "srt://127.0.0.1:4001",
	};
	await f.write({ input_mode: "mjpeg" });
	return {
		...f,
		wire,
		negotiate,
		bytes: () => Bun.file(`${f.dir}/config.json`).text(),
		setAnswer: (next: typeof answer) => {
			answer = next;
		},
		selection: () => {
			const config = getConfig();
			return {
				source: config.source,
				pipeline: config.pipeline,
				input_mode: config.input_mode,
				selected_video_input: config.selected_video_input,
				source_stable_id: config.source_stable_id,
			};
		},
	};
}
