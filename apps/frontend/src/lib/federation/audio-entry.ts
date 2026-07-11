import { mount, unmount } from "svelte";
import "../../app.css";

import AudioDialog from "$main/dialogs/AudioDialog.svelte";
import {
	FEDERATION_ABI_VERSION,
	type FederationMountHandle,
	type FederationMountOptions,
} from "./host-contract";
import { mountFederationToastHost } from "./toast-host";

export const federationAbiVersion = FEDERATION_ABI_VERSION;

export function mountDialog(
	target: Element,
	options: FederationMountOptions,
): FederationMountHandle {
	const destroyToastHost = mountFederationToastHost(target);
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
	return {
		destroy: async () => {
			await unmount(component);
			await destroyToastHost();
		},
	};
}
