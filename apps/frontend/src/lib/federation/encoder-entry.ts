import type {
	ConfigMessage,
	Framerate,
	Resolution,
	VideoCodec,
} from "@ceraui/rpc/schemas";
import { mount, unmount } from "svelte";
import "../../app.css";
import { buildEncoderSetConfig } from "$lib/streaming/encoderConfig";
import EncoderDialog from "$main/dialogs/EncoderDialog.svelte";
import {
	FEDERATION_ABI_VERSION,
	type FederationMountHandle,
	type FederationMountOptions,
} from "./host-contract";

export const federationAbiVersion = FEDERATION_ABI_VERSION;

type HostedEncoderConfig = {
	readonly source?: string;
	readonly resolution: Resolution | undefined;
	readonly framerate: Framerate | undefined;
	readonly bitrate: number | undefined;
	readonly bitrateOverlay: boolean | undefined;
	readonly codec?: VideoCodec;
};

function encoderConfig(config: ConfigMessage | undefined): HostedEncoderConfig {
	return {
		resolution: config?.resolution,
		framerate: config?.framerate,
		bitrate: config?.max_br,
		bitrateOverlay: config?.bitrate_overlay,
		codec: config?.video_codec,
	};
}

export function mountDialog(
	target: Element,
	options: FederationMountOptions,
): FederationMountHandle {
	const component = mount(EncoderDialog, {
		target,
		props: {
			open: true,
			config: encoderConfig(options.config),
			onSave: (draft: HostedEncoderConfig) => {
				void options.host.setConfig(buildEncoderSetConfig(draft, undefined));
			},
		},
	});
	return { destroy: () => unmount(component) };
}
