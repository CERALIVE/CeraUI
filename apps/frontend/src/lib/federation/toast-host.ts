import { mount, unmount } from "svelte";
import FederationToastHost from "./FederationToastHost.svelte";

export function mountFederationToastHost(target: Element): () => Promise<void> {
	const host = mount(FederationToastHost, { target });
	return () => unmount(host);
}
