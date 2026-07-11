import { mount, unmount } from "svelte";

import ServerDialog from "$main/dialogs/ServerDialog.svelte";
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
	const component = mount(ServerDialog, {
		target,
		props: {
			open: true,
			hostAdapter: options.host,
			initialConfig: options.config,
		},
	});
	return { destroy: () => unmount(component) };
}
