import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * A page-WS stand-in for the four broadcasts the Internet-Sharing card reads.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The uplink-health engine, the steering layer and the shaper are all
 * `isRealDevice()`-gated, so a dev/CI worker publishes NOTHING for any of them
 * — that silence IS the documented real-vs-mock seam, and adding a mock
 * provider for them would be a second, parallel mechanism rather than the
 * established one. There is also no mock scenario that can produce a captive
 * portal, a foreign qdisc or a hard-down conntrack drain.
 *
 * So this is the same drop-and-inject shape `bluetooth-wire.ts` uses: the
 * backend's own frames for these topics are dropped and an authoritative
 * payload is pushed instead. It proves the FRONTEND half end to end in a real
 * browser — it does NOT prove the device half, which is covered by the backend
 * suites and by the labelled hardware gate.
 *
 * The frame shape is exactly `buildMessage(type, data)`'s: one key, no `seq`,
 * so the drop-stale guard is bypassed the same way a pulled snapshot is.
 */

export interface WireUplink {
	iface: string;
	kind: "ethernet" | "wifi" | "cellular" | "other";
	state: "up" | "degraded" | "down";
	reason?: "probe_failed" | "captive_portal" | "passive_congestion" | "definitive_loss";
	weight: number;
	lastTransition: number;
	staleAt: number;
	probes: { successes: number; failures: number };
	signals: { activeAt?: number; passiveAt?: number };
}

export interface WireSteering {
	state: "available" | "steering_unavailable";
	reason?: string;
	detail?: string;
}

export interface WireShaper {
	state: "available" | "shaper_unavailable";
	mode?: "idle" | "streaming";
	algorithm?: "cake" | "htb-fq_codel";
	reason?: string;
	priorityDegraded?: true;
	detail?: string;
}

export interface SharingWireState {
	uplinks: WireUplink[];
	steering: WireSteering;
	shaper: WireShaper;
	/**
	 * A wired port to declare `shared-lan` — what makes a client zone ACTIVE.
	 * Without one, `sharing-off` supersedes every reachability band, so the
	 * degraded cases cannot be reached. PATCHED INTO the device's own `netif`
	 * frame rather than replacing it, so the rest of the page stays real.
	 */
	sharedLan?: string;
}

/** The topics this harness OWNS; a backend frame for any of them is dropped. */
const OWNED_TOPICS = ["uplinks", "uplink-steering", "uplink-shaper"] as const;

const NOW = Date.now();

/** The synthetic wired port every fixture declares as its client zone. */
export const SHARED_LAN_IFNAME = "eth-share0";

/** An interface no fixture lists, so a notice naming it cannot match a row. */
export const FLOWS_RESET_IFNAME = "wwan9";

/** Three uplinks: two healthy cellular legs plus a captive-portalled Wi-Fi. */
export function healthyThreeUplinks(): SharingWireState {
	return {
		uplinks: [
			{
				iface: "wwan0",
				kind: "cellular",
				state: "up",
				weight: 100,
				lastTransition: NOW - 300_000,
				staleAt: NOW + 3_600_000,
				probes: { successes: 42, failures: 0 },
				signals: { activeAt: NOW - 2_000 },
			},
			{
				iface: "wwan1",
				kind: "cellular",
				state: "up",
				weight: 100,
				lastTransition: NOW - 240_000,
				staleAt: NOW + 3_600_000,
				probes: { successes: 38, failures: 1 },
				signals: { activeAt: NOW - 3_000 },
			},
			{
				iface: "wlan0",
				kind: "wifi",
				state: "degraded",
				reason: "captive_portal",
				weight: 25,
				lastTransition: NOW - 60_000,
				staleAt: NOW + 3_600_000,
				probes: { successes: 9, failures: 4 },
				signals: { activeAt: NOW - 5_000 },
			},
		],
		steering: { state: "available" },
		shaper: { state: "available", mode: "streaming", algorithm: "cake" },
		sharedLan: SHARED_LAN_IFNAME,
	};
}

/** Every uplink down, and one of them visibly stale. */
export function degradedUplinks(): SharingWireState {
	return {
		uplinks: [
			{
				iface: "wwan0",
				kind: "cellular",
				state: "down",
				reason: "definitive_loss",
				weight: 0,
				lastTransition: NOW - 15_000,
				staleAt: NOW - 5_000,
				probes: { successes: 0, failures: 9 },
				signals: {},
			},
			{
				iface: "eth0",
				kind: "ethernet",
				state: "down",
				reason: "probe_failed",
				weight: 0,
				lastTransition: NOW - 20_000,
				staleAt: NOW + 3_600_000,
				probes: { successes: 0, failures: 12 },
				signals: { activeAt: NOW - 20_000 },
			},
		],
		steering: { state: "available" },
		shaper: {
			state: "shaper_unavailable",
			reason: "foreign_qdisc",
			priorityDegraded: true,
			detail: "root qdisc handle 8001: is not ours",
		},
		sharedLan: SHARED_LAN_IFNAME,
	};
}

/**
 * Healthy uplinks with NO client zone declared — the card's quiet state.
 *
 * Install it as the wire's INITIAL fixture rather than `set()`-ing it later: the
 * shared-LAN port is patched into the device's own `netif` frame, and the
 * frontend merge takes its key set from the incoming frame, so a switch to this
 * fixture only lands on the next device netif tick.
 */
export function sharingOff(): SharingWireState {
	const { sharedLan: _declared, ...rest } = healthyThreeUplinks();
	return rest;
}

/** Healthy uplinks, but the steering layer refused to publish its ruleset. */
export function steeringUnavailable(): SharingWireState {
	return {
		...healthyThreeUplinks(),
		steering: {
			state: "steering_unavailable",
			reason: "ruleset_publish_failed",
			detail: "nft -c -f /run/ceralive/share.nft exited 1",
		},
	};
}

export interface SharingWire {
	/** Push the current payload for every owned topic. */
	publish(): Promise<void>;
	/** Replace the payload and push it. */
	set(next: SharingWireState): Promise<void>;
	/** Raise the one-shot hard-down transient for an interface. */
	flowsReset(iface: string, linkId: string): Promise<void>;
	current(): SharingWireState;
}

/**
 * Install the proxy. Must run BEFORE `page.goto`, like every other WS harness
 * in this suite — a route installed after boot misses the initial-state push.
 */
export async function installSharingWire(
	page: Page,
	initial: SharingWireState = healthyThreeUplinks(),
): Promise<SharingWire> {
	let state: SharingWireState = structuredClone(initial);
	let route: WebSocketRoute | null = null;

	const send = (): void => {
		route?.send(JSON.stringify({ uplinks: state.uplinks }));
		route?.send(JSON.stringify({ "uplink-steering": state.steering }));
		route?.send(JSON.stringify({ "uplink-shaper": state.shaper }));
	};

	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		route = ws;
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				const parsed = JSON.parse(text) as Record<string, unknown>;
				if (OWNED_TOPICS.some((topic) => topic in parsed)) return;
				const patched = withSharedLan(parsed, state.sharedLan);
				if (patched !== null) {
					ws.send(JSON.stringify(patched));
					return;
				}
			} catch {
				/* non-JSON / binary frame */
			}
			ws.send(message);
		});
	});

	return {
		publish() {
			send();
			return Promise.resolve();
		},
		set(next) {
			state = structuredClone(next);
			send();
			return Promise.resolve();
		},
		flowsReset(iface, linkId) {
			route?.send(JSON.stringify({ "uplink-flows-reset": { iface, linkId } }));
			return Promise.resolve();
		},
		current: () => state,
	};
}

/**
 * Add the declared shared-LAN port to a device `netif` frame, leaving every
 * real interface untouched. Returns `null` for any other frame.
 */
function withSharedLan(
	frame: Record<string, unknown>,
	ifname: string | undefined,
): Record<string, unknown> | null {
	if (ifname === undefined) return null;
	const netif = frame.netif;
	if (netif === null || typeof netif !== "object") return null;
	return {
		...frame,
		netif: {
			...(netif as Record<string, unknown>),
			[ifname]: {
				tp: 0,
				enabled: false,
				ip: "10.42.1.1",
				error: 8,
				ethRole: "shared-lan",
			},
		},
	};
}
