import { mount, unmount } from "svelte";
import "../../app.css";

import AudioDialog from "$main/dialogs/AudioDialog.svelte";
import {
	FEDERATION_ABI_VERSION,
	type FederationMountHandle,
	type FederationMountOptions,
} from "./host-contract";
import { applyFederationLocale, registerFederationMessages } from "./messages";
import { mountFederationToastHost } from "./toast-host";

registerFederationMessages();

export const federationAbiVersion = FEDERATION_ABI_VERSION;

export function mountDialog(
	target: Element,
	options: FederationMountOptions,
): FederationMountHandle {
	applyFederationLocale(options.locale);
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
			// Both additive-optional on the ABI: a host that supplies neither gets
			// the pre-Todo-20 dialog exactly, because an absent capability snapshot
			// renders the backend selector as zero nodes.
			capabilities: options.capabilities,
			audioBackend: options.config?.audio_backend,
		},
	});
	return {
		destroy: async () => {
			await unmount(component);
			await destroyToastHost();
		},
	};
}
