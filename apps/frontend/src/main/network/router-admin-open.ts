/*
	Opening a router dongle's OWN admin web UI through CeraUI's proxy.

	Shared by the Cellular row and the dongle dialog so the two surfaces cannot
	drift into two different open behaviours for one device.

	A NEW TAB, not an iframe, and that is measured rather than assumed: the bench
	Huawei E3372 answers `X-Frame-Options: deny` and the ZTE answers
	`sameorigin`, so neither will render inside CeraUI. The proxy strips those
	headers from what IT serves — otherwise a dongle would be dictating framing
	policy for the device's own origin — but embedding a whole vendor SPA inside
	the operator's control plane is a different decision from making it reachable,
	and only the second one is being made here.

	THE TAB IS OPENED SYNCHRONOUSLY, BEFORE the await. A popup blocker only trusts
	a `window.open` that happens inside the user gesture, so opening it after the
	RPC resolves is silently blocked in every browser. The tab is parked on
	`about:blank` and navigated once the device answers, or closed again if it
	refuses — so a refusal never strands a blank tab.

	IT MUST NOT BE OPENED WITH `noopener`. That feature makes `window.open` return
	`null` BY SPEC, so the handle needed to navigate the parked tab never exists —
	found in a real browser, where the operator's own tab navigated away to the
	dongle instead and the rest of the Network page went with it. The opener link
	is severed straight after the call instead, which costs nothing here: the
	proxied page is served from CeraUI's OWN origin, so it is same-origin either
	way and `noopener` was never what governed it.
*/

import type { OpenRouterAdminRefusal } from "@ceraui/rpc/schemas";
import { rpc } from "$lib/rpc";

export type RouterAdminOpenOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason?: OpenRouterAdminRefusal };

export type RouterAdminOpenDeps = {
	openTab: () => Window | null;
	request: (device: string) => Promise<{
		success: boolean;
		url?: string;
		error?: OpenRouterAdminRefusal;
	}>;
};

const defaultDeps: RouterAdminOpenDeps = {
	openTab: () => {
		const tab = window.open("", "_blank");
		if (tab !== null) {
			try {
				tab.opener = null;
			} catch {
				// Not settable in this browser; the page is same-origin regardless.
			}
		}
		return tab;
	},
	request: (device) => rpc.modems.openRouterAdmin({ device }),
};

export async function openRouterAdminUi(
	device: string,
	deps: RouterAdminOpenDeps = defaultDeps,
): Promise<RouterAdminOpenOutcome> {
	const tab = deps.openTab();
	let result: Awaited<ReturnType<RouterAdminOpenDeps["request"]>>;
	try {
		result = await deps.request(device);
	} catch {
		tab?.close();
		return { ok: false };
	}
	if (!result.success || result.url === undefined) {
		tab?.close();
		return result.error === undefined
			? { ok: false }
			: { ok: false, reason: result.error };
	}
	if (tab === null) {
		// The blocker won anyway; a same-tab navigation still beats no navigation.
		window.location.assign(result.url);
		return { ok: true };
	}
	tab.location.replace(result.url);
	return { ok: true };
}

/** i18n key for a refusal, or the generic one when the device named no reason. */
export function routerAdminOpenReasonKey(
	reason: OpenRouterAdminRefusal | undefined,
): string {
	return reason === undefined
		? "network.routerCellular.adminOpenFailed"
		: `network.routerCellular.adminOpenReason.${reason}`;
}
