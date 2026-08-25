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
	#running: Promise<void> = Promise.resolve();

	constructor(deps: UplinkShaperCoordinatorDeps) {
		this.#deps = deps;
	}

	update(update: ShaperUpdate): Promise<void> {
		this.#running = this.#running.then(() => this.#applyUpdate(update));
		return this.#running;
	}

	async #applyUpdate(update: ShaperUpdate): Promise<void> {
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
		const edge = update.streaming !== this.#streaming;
		this.#streaming = update.streaming;
		if (edge || update.streaming || uplinks.length > 0)
			await this.#deps.apply({ mode, uplinks });
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
