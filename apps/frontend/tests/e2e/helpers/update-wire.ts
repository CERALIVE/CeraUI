import type { Page, WebSocketRoute } from "@playwright/test";

import type {
	UpdateCapabilities,
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateOrchestratorWireState,
} from "@ceraui/rpc/schemas";

/**
 * A page-WS stand-in for the update orchestrator (Todo 41).
 *
 * The orchestrator never leaves `idle` on a dev/CI worker — nothing is ever
 * downloaded or committed there — and no mock scenario can produce a
 * committing, staged or cellular-held update. So this harness OWNS the
 * `update_orchestrator` field: every device `status` frame is patched to carry
 * the harness state instead (the backend re-sends its own `idle` on every
 * status tick, which would otherwise overwrite an injected phase), and the
 * dialog's reads can be answered with a fixture. Everything else on the page —
 * auth, settings persistence, the rest of the status frame — is the real
 * worker backend.
 *
 * It proves the FRONTEND half end to end in a real browser. It does not prove
 * the orchestrator itself, which the backend suites cover.
 */

type Frame = Record<string, unknown>;

export function orchestratorState(
	phase: UpdateOrchestratorPhase,
	progress?: { percent: number; etaSeconds: number },
): UpdateOrchestratorWireState {
	return {
		schema: 1,
		phase,
		progress: progress ?? null,
		failure_reason: null,
		cellular_override_id: null,
	};
}

export const LEGACY_CAPABILITIES: UpdateCapabilities = {
	mode: "legacy",
	features: [],
};

export const CAPABLE_CAPABILITIES: UpdateCapabilities = {
	mode: "capable",
	features: ["apt-all-packages", "rauc-verity-streaming", "slot-sync"],
};

/** 700 MiB — `formatBytes('en')` renders it as exactly "700 MB". */
export const CELLULAR_IMAGE_BYTES = 734_003_200;
export const CELLULAR_IMAGE_ID = "2026.10.1";

export function capableDetails(
	overrides: Partial<UpdateDetails> = {},
): UpdateDetails {
	const now = Date.now();
	return {
		slots: [
			{
				name: "rootfs.0",
				bootname: "A",
				state: "booted",
				bootStatus: "good",
				version: "2026.9.3",
				lastSyncedAt: new Date(now - 3_600_000).toISOString(),
			},
			{
				name: "rootfs.1",
				bootname: "B",
				state: "inactive",
				bootStatus: "good",
				version: "2026.9.3",
				lastSyncedAt: new Date(now - 3_600_000).toISOString(),
			},
		],
		os: {
			bootedVersion: "2026.9.3",
			staged: null,
			candidate: { version: CELLULAR_IMAGE_ID, sizeBytes: CELLULAR_IMAGE_BYTES },
		},
		checks: {
			packages: {
				lastAttemptAt: now - 3_600_000,
				lastSuccessAt: now - 3_600_000,
				nextAttemptAt: now + 6 * 3_600_000,
			},
			os: {
				lastAttemptAt: now - 3_600_000,
				lastSuccessAt: now - 3_600_000,
				nextAttemptAt: now + 12 * 3_600_000,
			},
		},
		pendingCellular: { id: CELLULAR_IMAGE_ID, sizeBytes: CELLULAR_IMAGE_BYTES },
		transport: {
			profile: "os",
			checkedAt: now - 60_000,
			status: "selected",
			selected: { ifname: "wwan0", kind: "cellular", family: 4, metered: true },
			findings: [
				{
					ifname: "wwan0",
					kind: "cellular",
					family: 4,
					metered: true,
					healthy: true,
					captive: false,
					states: [],
				},
			],
		},
		...overrides,
	};
}

// ── start-able Live cockpit ──────────────────────────────────────────────────
// The default dev backend has no stream destination, so Start is disabled for
// reasons that have nothing to do with updates. The same injection
// `stream-start-failure.spec.ts` uses makes all four readiness gates green.

const KNOWN_PIPELINE = "e2e-update-pipeline";
const KNOWN_SOURCE = "e2e-update-source";

const START_SOURCE = {
	origin: "capture",
	id: KNOWN_SOURCE,
	pipelineId: KNOWN_PIPELINE,
	kind: "hdmi",
	displayName: "E2E Update Camera",
	devicePath: "/dev/video0",
	modes: [{ width: 1920, height: 1080, framerates: [30, 60] }],
	supportsAudio: false,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audioKind: "none",
	available: true,
};

export interface UpdateWireOptions {
	/**
	 * The orchestrator state every `status` frame carries. `null` models a
	 * backend that publishes none — the key is DROPPED. Note that the frontend
	 * status merge preserves an omitted field, so `null` only means "never
	 * published" when set before the first frame; use a resting phase to retract.
	 */
	orchestrator?: UpdateOrchestratorWireState | null;
	/** RPC path → result. A matched call never reaches the backend. */
	fakes?: Record<string, unknown>;
	/** Inject a pipeline, a source and a destination so Start is enabled. */
	startable?: boolean;
}

export interface UpdateWire {
	/** Replace the orchestrator state and push it to the page now. */
	setOrchestrator(next: UpdateOrchestratorWireState): void;
	fake(path: string, result: unknown): void;
	/** Inputs of every outbound call to `path`, in order (faked or not). */
	calls(path: string): unknown[];
	/** Push the pipeline/source/config that enable Start (after navigation). */
	pushStartable(): void;
}

/**
 * Install the proxy. Must run BEFORE `page.goto` — a route installed after
 * boot misses the initial-state push.
 */
export async function installUpdateWire(
	page: Page,
	options: UpdateWireOptions = {},
): Promise<UpdateWire> {
	let orchestrator: UpdateOrchestratorWireState | null =
		options.orchestrator === undefined
			? orchestratorState("idle")
			: options.orchestrator;
	const fakes = new Map<string, unknown>(Object.entries(options.fakes ?? {}));
	const recorded: Array<{ path: string; input: unknown }> = [];
	const startable = options.startable === true;
	let route: WebSocketRoute | null = null;

	const pushOrchestrator = (): void => {
		if (orchestrator === null) return;
		route?.send(JSON.stringify({ status: { update_orchestrator: orchestrator } }));
	};

	const patchInbound = (frame: Frame): boolean => {
		const status = frame.status as Frame | undefined;
		if (status && "update_orchestrator" in status) {
			if (orchestrator === null) delete status.update_orchestrator;
			else status.update_orchestrator = orchestrator;
		}
		if (!startable) return true;
		if (status && "is_streaming" in status) status.is_streaming = false;
		const config = frame.config as Frame | undefined;
		if (config) {
			config.pipeline = KNOWN_PIPELINE;
			config.source = KNOWN_SOURCE;
			if (!config.srtla_addr && !config.relay_server) config.srtla_addr = "127.0.0.1";
		}
		return !("pipelines" in frame) && !("sources" in frame);
	};

	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\/ws(?:\?|$)/, (ws) => {
		route = ws;
		const server = ws.connectToServer();
		ws.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				const frame = JSON.parse(text) as Frame;
				const path = Array.isArray(frame.path) ? (frame.path as string[]).join(".") : "";
				if (path) recorded.push({ path, input: frame.input });
				if (path && fakes.has(path)) {
					const result = fakes.get(path);
					setTimeout(() => ws.send(JSON.stringify({ id: frame.id, result })), 0);
					return;
				}
			} catch {
				/* keepalive / non-JSON frame */
			}
			server.send(message);
		});
		server.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				const frame = JSON.parse(text) as Frame;
				if (!patchInbound(frame)) return;
				ws.send(JSON.stringify(frame));
				return;
			} catch {
				/* binary frame */
			}
			ws.send(message);
		});
	});

	return {
		setOrchestrator(next) {
			orchestrator = next;
			pushOrchestrator();
		},
		fake(path, result) {
			fakes.set(path, result);
		},
		calls(path) {
			return recorded.filter((call) => call.path === path).map((call) => call.input);
		},
		pushStartable() {
			route?.send(
				JSON.stringify({
					pipelines: {
						hardware: "generic",
						pipelines: {
							[KNOWN_PIPELINE]: {
								name: "E2E Update Pipeline",
								supportsAudio: false,
								supportsResolutionOverride: false,
								supportsFramerateOverride: false,
							},
						},
					},
				}),
			);
			route?.send(JSON.stringify({ sources: { hardware: "generic", sources: [START_SOURCE] } }));
			route?.send(
				JSON.stringify({
					config: { pipeline: KNOWN_PIPELINE, source: KNOWN_SOURCE, srtla_addr: "127.0.0.1" },
				}),
			);
		},
	};
}
