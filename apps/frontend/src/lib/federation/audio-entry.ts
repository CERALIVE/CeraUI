import { mount, unmount } from "svelte";
import "../../app.css";

import AudioDialog from "$main/dialogs/AudioDialog.svelte";
import {
	FEDERATION_ABI_VERSION,
	type FederationMountHandle,
	type FederationMountOptions,
} from "./host-contract";

export const federationAbiVersion = FEDERATION_ABI_VERSION;

export function mountDialog(
	target: Element,
	options: FederationMountOptions,
): FederationMountHandle {
	const component = mount(AudioDialog, {
		target,
		props: {
			open: true,
			audioSource: options.config?.asrc,
			audioCodec: options.config?.acodec,
			audioDelay: options.config?.delay,
			effectivePipeline: options.config?.pipeline,
			hostAdapter: options.host,
		},
	});
	return { destroy: () => unmount(component) };
}
