import {
	SHAPER_CONFIG,
	type ShaperApplyRequest,
	type ShaperTelemetry,
	type ShaperUpdate,
} from "./contracts.ts";
import { advanceAimd, updateBaselineRtt } from "./controller.ts";

export interface UplinkShaperCoordinatorDeps {
	readonly apply: (request: ShaperApplyRequest) => Promise<unknown>;
	readonly readBacklog?: (ifname: string) => Promise<number>;
}

interface UplinkControllerState {
	capBps: number;
	baselineRttMs?: number;
	lastNakCount?: number;
	backlogTicks: number;
}

export class UplinkShaperCoordinator {
	readonly #deps: UplinkShaperCoordinatorDeps;
	readonly #states = new Map<string, UplinkControllerState>();
	#streaming = false;
	#applicationPending = false;
	#running: Promise<void> = Promise.resolve();

	constructor(deps: UplinkShaperCoordinatorDeps) {
		this.#deps = deps;
	}

	update(update: ShaperUpdate): Promise<void> {
		// The caller gets this update's own outcome, rejection included. The
		// serialization tail only waits for it to SETTLE: one failed ownership
		// read must not reject every later update before it can read again.
		const result = this.#running.then(() => this.#applyUpdate(update));
		this.#running = result.catch(() => undefined);
		return result;
	}

	async #applyUpdate(update: ShaperUpdate): Promise<void> {
		const edge = update.streaming !== this.#streaming;
		this.#applicationPending ||=
			edge || update.streaming || update.sharedUplinks.length > 0;
		const mode = update.streaming ? "streaming" : "idle";
		const enteringStreaming = update.streaming && !this.#streaming;
		const telemetry = new Map(
			update.telemetry.map((sample) => [sample.iface, sample]),
		);
		const uplinks = [];
		for (const shared of update.sharedUplinks) {
			const sample = enteringStreaming
				? undefined
				: telemetry.get(shared.ifname);
			if (enteringStreaming) {
				const prior = this.#states.get(shared.ifname);
				this.#states.set(shared.ifname, {
					capBps: SHAPER_CONFIG.bootstrapCapBps,
					backlogTicks: 0,
					...(prior?.baselineRttMs === undefined
						? {}
						: { baselineRttMs: prior.baselineRttMs }),
				});
			}
			const state = await this.#nextState(
				shared.ifname,
				sample,
				update.streaming,
			);
			uplinks.push({
				ifname: shared.ifname,
				mark: shared.mark,
				capBps: state.capBps,
			});
		}
		if (this.#applicationPending) {
			await this.#deps.apply({ mode, uplinks });
			this.#applicationPending = false;
			this.#streaming = update.streaming;
		}
	}

	async #nextState(
		ifname: string,
		sample: ShaperTelemetry | undefined,
		streaming: boolean,
	): Promise<UplinkControllerState> {
		const prior = this.#states.get(ifname) ?? {
			capBps: SHAPER_CONFIG.bootstrapCapBps,
			backlogTicks: 0,
		};
		if (!streaming) {
			const baselineRttMs =
				sample?.stale === false
					? updateBaselineRtt(prior.baselineRttMs, sample.rttMs)
					: prior.baselineRttMs;
			const next: UplinkControllerState = {
				...prior,
				...(baselineRttMs === undefined ? {} : { baselineRttMs }),
			};
			this.#states.set(ifname, next);
			return next;
		}
		if (sample === undefined || sample.stale) return prior;
		const baselineRttMs = prior.baselineRttMs ?? sample.rttMs;
		const backlogBytes = await (this.#deps.readBacklog?.(ifname) ??
			Promise.resolve(0));
		const backlogTicks =
			backlogBytes >= SHAPER_CONFIG.backlogThresholdBytes
				? prior.backlogTicks + 1
				: 0;
		const result = advanceAimd(prior.capBps, {
			stale: false,
			rttMs: sample.rttMs,
			baselineRttMs,
			nakDelta: Math.max(
				0,
				sample.nakCount - (prior.lastNakCount ?? sample.nakCount),
			),
			backlogBytes,
			backlogTicks,
		});
		const next = {
			capBps: result.capBps,
			baselineRttMs,
			lastNakCount: sample.nakCount,
			backlogTicks,
		};
		this.#states.set(ifname, next);
		return next;
	}
}
