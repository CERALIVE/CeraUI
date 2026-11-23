import { logger } from "../../helpers/logger.ts";
import { getNetifTopologyGeneration } from "../network/netif-topology-generation.ts";
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

type RadioPublication = () => void | boolean | Promise<void> | Promise<boolean>;

type PendingObservation = {
	readonly devices: readonly RadioObservation[];
	readonly sequence: number;
	readonly topologyGeneration: number;
	readonly onPublication: RadioPublication | undefined;
};

/** Discovery awaits the initial sample; lost samples retain bounded retries. */
export class WifiRadioObservation {
	private queued: PendingObservation | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private retries = 0;
	private discovery = 0;
	private cancellation = 0;
	private stopped = false;
	private terminated = false;
	private resumeRead: (() => void) | undefined;
	private physicalWitnesses: readonly RadioObservation[] = [];
	private active:
		| { readonly controller: AbortController; readonly promise: Promise<void> }
		| undefined;

	constructor(private readonly producer: WifiRadioIdentityProducer) {}

	get settled(): Promise<void> | undefined {
		return this.active?.promise;
	}

	enqueue(
		devices: readonly RadioObservation[],
		sequence: number,
		onPublication?: RadioPublication,
		topologyGeneration = getNetifTopologyGeneration(),
	): void {
		if (this.terminated) return;
		this.stopped = false;
		this.discovery++;
		this.retries = 0;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.queued || sequence > this.queued.sequence) {
			const complete = new Map(
				this.physicalWitnesses.map((device) => [device.ifname, device]),
			);
			for (const device of devices) complete.set(device.ifname, device);
			this.queued = {
				devices: [...complete.values()],
				sequence,
				topologyGeneration,
				onPublication,
			};
		}
		if (!this.active && !this.resumeRead && this.timer === undefined) {
			this.timer = setTimeout(() => this.start(), 0).unref();
		}
	}

	async sample(
		devices: readonly RadioObservation[],
		sequence: number,
		onPublication: RadioPublication,
		topologyGeneration: number,
	): Promise<boolean> {
		await this.active?.promise;
		if (this.terminated) return false;
		const cancellation = this.cancellation;
		this.physicalWitnesses = devices.map(({ ifname, degradedReason }) => ({
			ifname,
			...(degradedReason ? { degradedReason } : {}),
		}));
		this.enqueue(devices, sequence, onPublication, topologyGeneration);
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.start(false);
		await this.active?.promise;
		return !this.terminated && cancellation === this.cancellation;
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
		this.physicalWitnesses = [];
		this.stop();
	}

	reopenForTest(): void {
		this.terminated = false;
		this.physicalWitnesses = [];
	}

	private start(publish = true): void {
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
				this.producer.discover(
					next.devices,
					next.sequence,
					controller.signal,
					next.topologyGeneration,
				),
			)
			.then(() =>
				this.producer.publishedObservation === next.sequence
					? "published"
					: "superseded",
			)
			.catch(() => "rejected");
		const promise = Promise.race([sample, aborted.promise])
			.then(async (outcome) => {
				if (
					this.stopped ||
					this.terminated ||
					cancellation !== this.cancellation
				)
					return;
				let loss = outcome;
				if (outcome === "published") {
					clearTimeout(timeout);
					if (publish && (await next.onPublication?.()) === false) return;
					if (
						this.stopped ||
						this.terminated ||
						cancellation !== this.cancellation
					)
						return;
					const currentRows = Object.values(getWifiInterfacesByMacAddress());
					if (
						publish &&
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
						({ row, ifname, degradedReason }) =>
							next.onPublication
								? degradedReason !== "unavailable" &&
									degradedReason !== "operational-mac-missing" &&
									this.producer.state.rows.get(ifname)?.classification !==
										"verified"
								: row !== undefined &&
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
					const current = new Map(
						Object.values(getWifiInterfacesByMacAddress()).map((row) => [
							row.ifname,
							row,
						]),
					);
					const devices = next.devices.map(({ ifname, degradedReason }) => {
						const row = current.get(ifname);
						if (row) invalidateWifiRadioRow(row, sequence);
						const reason = row?.degradedReason ?? degradedReason;
						return {
							ifname,
							...(row ? { row } : {}),
							...(reason ? { degradedReason: reason } : {}),
						};
					});
					this.queued = {
						...next,
						devices,
						sequence,
					};
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
