import { mount, unmount } from "svelte";
import "../../app.css";

import ServerDialog from "$main/dialogs/ServerDialog.svelte";
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
	const component = mount(ServerDialog, {
		target,
		props: {
			open: true,
			hostAdapter: options.host,
			initialConfig: options.config,
		},
	});
	return {
		destroy: async () => {
			await unmount(component);
			await destroyToastHost();
		},
	};
}
