import type {
	HotspotConfigOutput,
	HotspotToggleOutput,
	WifiInterface,
	WifiMessage,
	WifiStatus,
} from "@ceraui/rpc/schemas";
import { NotSentError, RpcError } from "./rpc-error";
import { getLinkEpoch } from "./session-epoch.svelte";

const waiters = new Set<(status: WifiStatus) => void>();
type WifiConfigReceipt = NonNullable<
	NonNullable<WifiMessage["hotspot"]>["config"]
>;
type WifiConfigDispatch = {
	readonly device: string;
	readonly incarnation: string;
	readonly link: number;
	receive: ((config?: WifiConfigReceipt) => void) | undefined;
};
const configDispatches = new Set<WifiConfigDispatch>();

type WifiStartReceipt = NonNullable<
	NonNullable<WifiMessage["hotspot"]>["start"]
>;
type WifiStartOutcome = HotspotToggleOutput & { readonly correlated?: true };
const startReceivers = new Map<string, (frame: WifiStartReceipt) => void>();

export function noteWifiStart(frame: WifiStartReceipt): void {
	if (frame.attempt) startReceivers.get(frame.attempt)?.(frame);
}

export async function withWifiStartReceipt(
	device: string,
	invoke: (attempt: string) => Promise<HotspotToggleOutput>,
	signal: AbortSignal,
): Promise<WifiStartOutcome> {
	// getRandomValues also works on a plain-HTTP device LAN.
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const attempt = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	const link = getLinkEpoch();
	const { promise, resolve } = Promise.withResolvers<
		WifiStartReceipt | undefined
	>();
	let terminal: WifiStartReceipt | undefined;
	const abort = () => {
		startReceivers.delete(attempt);
		resolve(undefined);
	};
	startReceivers.set(attempt, (frame) => {
		if (String(frame.device) !== device || getLinkEpoch() !== link) return;
		if (terminal || (frame.success !== true && !frame.error)) return;
		terminal = frame;
		resolve(frame);
	});
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (signal.aborted) return { success: false, error: "binding-required" };
		const ack = await invoke(attempt);
		const frame = ack.success && ack.accepted ? await promise : terminal;
		return frame?.error && !signal.aborted
			? {
					success: false,
					error: frame.error,
					reason: frame.reason,
					correlated: true,
				}
			: ack;
	} finally {
		startReceivers.delete(attempt);
		signal.removeEventListener("abort", abort);
	}
}

export function noteWifiStatus(status: WifiStatus): void {
	for (const receive of [...waiters]) receive(status);
}

/** A retired dispatch still owns its late terminal, never a replacement Save. */
export function noteWifiConfig(config: WifiConfigReceipt): boolean {
	if (
		config.error === "binding-required" ||
		(config.success === undefined && config.error === undefined)
	)
		return true;
	const link = getLinkEpoch();
	for (const dispatch of configDispatches) {
		if (
			dispatch.link === link &&
			dispatch.device === String(config.device) &&
			dispatch.incarnation === config.incarnation
		) {
			configDispatches.delete(dispatch);
			const receive = dispatch.receive;
			receive?.(config);
			return receive !== undefined;
		}
	}
	return true;
}

/** Own the RPC and its possible terminal through the same dispatch reservation. */
export async function withWifiConfigReceipt(
	binding: { readonly device: string; readonly incarnation: string },
	invoke: () => Promise<HotspotConfigOutput>,
	owner: {
		readonly signal: AbortSignal;
		readonly unobserved?: () => void;
	},
): Promise<HotspotConfigOutput> {
	const { signal, unobserved } = owner;
	const link = getLinkEpoch();
	// Old sockets cannot deliver into this epoch; same-socket debts must drain.
	for (const dispatch of configDispatches) {
		if (dispatch.link !== link) {
			configDispatches.delete(dispatch);
			dispatch.receive?.();
		}
	}
	const dispatch: WifiConfigDispatch = { ...binding, link, receive: undefined };
	configDispatches.add(dispatch);
	const terminal = new Promise<WifiConfigReceipt | undefined>((resolve) => {
		const finish = (config?: WifiConfigReceipt) => {
			dispatch.receive = undefined;
			signal.removeEventListener("abort", abort);
			resolve(config);
		};
		dispatch.receive = (config) => {
			if (
				config?.error === "radio-changed" &&
				config.reason === "current-unobserved"
			)
				unobserved?.();
			finish(config);
		};
		const abort = () => finish();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
	try {
		const result = await invoke();
		if (!result.success) {
			// Entry refusals publish before their RPC reply; none remain in flight.
			configDispatches.delete(dispatch);
			return result;
		}
		const config = await terminal;
		return config?.error === "radio-changed"
			? { success: false, error: config.error, reason: config.reason }
			: result;
	} catch (error) {
		// Configure RPC errors precede writer admission; timeout/reset is uncertain.
		if (error instanceof NotSentError || error instanceof RpcError)
			configDispatches.delete(dispatch);
		throw error;
	} finally {
		dispatch.receive?.();
	}
}

/** Observe a future frame, including one whose row bytes have not changed. */
export function waitForWifiStatus(
	device: string,
	signal: AbortSignal,
): Promise<WifiInterface | undefined> {
	return new Promise((resolve) => {
		const finish = (row?: WifiInterface) => {
			clearTimeout(timer);
			waiters.delete(receive);
			signal.removeEventListener("abort", abort);
			resolve(row);
		};
		const receive = (status: WifiStatus) => {
			if (Object.hasOwn(status, device)) finish(status[device]);
		};
		const abort = () => finish();
		const timer = setTimeout(abort, 3000);
		waiters.add(receive);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}
