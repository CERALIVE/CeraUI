import { navElements } from "$lib/config";
import { navigateTo } from "$lib/stores/navigation.svelte";

type DestinationKey = "live" | "network" | "settings";

export function navigateToDestination(destination: DestinationKey): void {
	const element = navElements[destination];
	if (element !== undefined) navigateTo({ [destination]: element });
}
