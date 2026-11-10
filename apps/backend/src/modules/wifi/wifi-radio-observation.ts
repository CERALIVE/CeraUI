import {
	type RadioObservation,
	recordWifiRadioShadowFailure,
	type WifiRadioIdentityProducer,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";

export const RADIO_SHADOW_TIMEOUT_MS = 100;

type PendingObservation = {
	readonly devices: readonly RadioObservation[];
	readonly sequence: number;
};

/** Only shadow work coalesces; legacy discovery never waits on this queue. */
export class WifiRadioObservation {
	private queued: PendingObservation | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private active:
		| { readonly controller: AbortController; readonly promise: Promise<void> }
		| undefined;

	constructor(private readonly producer: WifiRadioIdentityProducer) {}

	get settled(): Promise<void> | undefined {
		return this.active?.promise;
	}

	enqueue(devices: readonly RadioObservation[], sequence: number): void {
		if (!this.queued || sequence > this.queued.sequence) {
			this.queued = { devices, sequence };
		}
		if (!this.active && this.timer === undefined) {
			this.timer = setTimeout(() => this.start(), 0);
		}
	}

	stop(): void {
		this.queued = undefined;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.active?.controller.abort();
	}

	private start(): void {
		this.timer = undefined;
		const next = this.queued;
		if (!next) return;
		this.queued = undefined;
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			if (!controller.signal.aborted) {
				recordWifiRadioShadowFailure();
				controller.abort();
			}
		}, RADIO_SHADOW_TIMEOUT_MS);
		const promise = Promise.resolve()
			.then(() =>
				this.producer.discover(next.devices, next.sequence, controller.signal),
			)
			.catch(() => {
				if (!controller.signal.aborted) recordWifiRadioShadowFailure();
			})
			.finally(() => {
				clearTimeout(timeout);
				this.active = undefined;
				if (this.queued) {
					this.timer = setTimeout(() => this.start(), 0);
				}
			});
		// Retain this physical slot after timeout until uncancellable I/O settles.
		// Aborted samples cannot publish or start another read; the queue stays one.
		this.active = { controller, promise };
	}
}

export const wifiRadioObservation = new WifiRadioObservation(wifiRadioIdentity);
