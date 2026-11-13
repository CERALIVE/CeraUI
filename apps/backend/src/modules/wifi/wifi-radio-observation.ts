import { logger } from "../../helpers/logger.ts";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import {
	type RadioObservation,
	recordWifiRadioShadowFailure,
	type WifiRadioIdentityProducer,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import {
	invalidateWifiRadioRow,
	notifyWifiRadioPublication,
	projectWifiRadioIncarnation,
} from "./wifi-radio-publication.ts";
import {
	deferWifiRadioRead,
	hasWifiRadioReadCapacity,
} from "./wifi-radio-read-budget.ts";

export const RADIO_SHADOW_TIMEOUT_MS = 1000;

const RETRY_DELAYS_MS = [250, 1000, 4000] as const;

type PendingObservation = {
	readonly devices: readonly RadioObservation[];
	readonly sequence: number;
};

/** Only shadow work coalesces; legacy discovery never waits on this queue. */
export class WifiRadioObservation {
	private queued: PendingObservation | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private retries = 0;
	private discovery = 0;
	private cancellation = 0;
	private stopped = false;
	private terminated = false;
	private resumeRead: (() => void) | undefined;
	private active:
		| { readonly controller: AbortController; readonly promise: Promise<void> }
		| undefined;

	constructor(private readonly producer: WifiRadioIdentityProducer) {}

	get settled(): Promise<void> | undefined {
		return this.active?.promise;
	}

	enqueue(devices: readonly RadioObservation[], sequence: number): void {
		if (this.terminated) return;
		this.stopped = false;
		this.discovery++;
		this.retries = 0;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.queued || sequence > this.queued.sequence) {
			this.queued = { devices, sequence };
		}
		if (!this.active && !this.resumeRead && this.timer === undefined) {
			this.timer = setTimeout(() => this.start(), 0).unref();
		}
	}

	stop(): void {
		this.stopped = true;
		this.discovery++;
		this.cancellation++;
		this.retries = 0;
		this.queued = undefined;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.resumeRead?.();
		this.resumeRead = undefined;
		this.active?.controller.abort();
	}

	terminate(): void {
		this.terminated = true;
		this.stop();
	}

	reopenForTest(): void {
		this.terminated = false;
	}

	private start(): void {
		this.timer = undefined;
		if (this.stopped || this.terminated || this.active) return;
		const next = this.queued;
		if (!next) return;
		if (!hasWifiRadioReadCapacity()) {
			this.resumeRead ??= deferWifiRadioRead(() => {
				this.resumeRead = undefined;
				if (!this.stopped && !this.terminated && !this.active && this.queued)
					this.start();
			});
			return;
		}
		this.queued = undefined;
		const controller = new AbortController();
		const discovery = this.discovery;
		const cancellation = this.cancellation;
		const wireBefore = new Map(
			Object.values(getWifiInterfacesByMacAddress()).map((row) => [
				row.ifname,
				projectWifiRadioIncarnation(
					row,
					this.producer.state.rows.get(row.ifname),
				),
			]),
		);
		const aborted = Promise.withResolvers<string>();
		let reason = "aborted";
		const onAbort = () => aborted.resolve(reason);
		controller.signal.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => {
			if (!controller.signal.aborted) {
				reason = "timed out";
				controller.abort();
			}
		}, RADIO_SHADOW_TIMEOUT_MS).unref();
		const sample = Promise.resolve()
			.then(() =>
				this.producer.discover(next.devices, next.sequence, controller.signal),
			)
			.then(() =>
				this.producer.publishedObservation === next.sequence
					? "published"
					: "superseded",
			)
			.catch(() => "rejected");
		const promise = Promise.race([sample, aborted.promise])
			.then((outcome) => {
				if (
					this.stopped ||
					this.terminated ||
					cancellation !== this.cancellation
				)
					return;
				let loss = outcome;
				if (outcome === "published") {
					const currentRows = Object.values(getWifiInterfacesByMacAddress());
					if (
						currentRows.some(
							(row) =>
								wireBefore.get(row.ifname) !==
								projectWifiRadioIncarnation(
									row,
									this.producer.state.rows.get(row.ifname),
								),
						)
					) {
						notifyWifiRadioPublication();
					}
					const incomplete = next.devices.some(
						({ row }) =>
							row !== undefined &&
							currentRows.includes(row) &&
							row.degradedReason === undefined &&
							projectWifiRadioIncarnation(
								row,
								this.producer.state.rows.get(row.ifname),
							) === undefined,
					);
					if (!incomplete) {
						this.retries = 0;
						return;
					}
					loss = "incomplete";
				}
				if (
					loss === "timed out" ||
					loss === "rejected" ||
					loss === "incomplete"
				) {
					recordWifiRadioShadowFailure();
				}
				const delay = RETRY_DELAYS_MS[this.retries];
				const retry =
					delay === undefined
						? "no retries left"
						: `retry ${this.retries + 1}/3`;
				logger.warn(
					`Wi-Fi identity sample lost (${loss}) for ${next.devices.map(({ ifname }) => ifname).join(", ")}; ${retry}`,
				);
				if (discovery !== this.discovery) return;
				if (delay === undefined) return;
				this.retries++;
				this.timer = setTimeout(() => {
					this.timer = undefined;
					if (this.stopped || this.terminated || discovery !== this.discovery)
						return;
					const sequence = this.producer.captureObservation();
					const devices = Object.values(getWifiInterfacesByMacAddress()).map(
						(row) => {
							invalidateWifiRadioRow(row, sequence);
							return {
								ifname: row.ifname,
								row,
								...(row.degradedReason
									? { degradedReason: row.degradedReason }
									: {}),
							};
						},
					);
					this.queued = { devices, sequence };
					this.start();
				}, delay).unref();
			})
			.finally(() => {
				clearTimeout(timeout);
				controller.signal.removeEventListener("abort", onAbort);
				this.active = undefined;
				if (this.queued && !this.stopped && !this.terminated) {
					this.timer = setTimeout(() => this.start(), 0).unref();
				}
			});
		// A timed-out read can settle later, but its aborted generation cannot publish.
		this.active = { controller, promise };
	}
}

export const wifiRadioObservation = new WifiRadioObservation(wifiRadioIdentity);
