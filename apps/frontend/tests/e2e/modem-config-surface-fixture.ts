import type { Page } from "./fixtures/index.js";

type ModemPatch = Record<string, unknown>;

type CeraHarnessState = {
	sendThrough: WebSocket["send"] | null;
	lastModems: Record<string, unknown> | null;
	rpcFake: Record<string, unknown>;
	seq: number;
	emit(type: string, payload: unknown): void;
};

declare global {
	interface Window {
		__ceraModemConfigSurface?: CeraHarnessState;
	}
}

export function installWsHarness(): void {
	if (window.__ceraModemConfigSurface) return;

	function isRecordFrame(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null;
	}

	function parseFrame(value: unknown): unknown | undefined {
		try {
			const parsed: unknown = JSON.parse(String(value));
			return parsed;
		} catch (error) {
			if (error instanceof SyntaxError) return undefined;
			throw error;
		}
	}

	const RealWebSocket = window.WebSocket;

	window.__ceraModemConfigSurface = {
		sendThrough: null,
		lastModems: null,
		rpcFake: {},
		seq: 0,
		emit(type: string, payload: unknown) {
			const state = window.__ceraModemConfigSurface;
			if (!state?.sendThrough) return;
			state.sendThrough(
				JSON.stringify({
					id: `emit-${++state.seq}`,
					path: ["dev", "emit"],
					input: { type, payload },
				}),
			);
		},
	};

	class HookedWebSocket extends RealWebSocket {
		private readonly sendThrough: WebSocket["send"];

		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			this.sendThrough = RealWebSocket.prototype.send.bind(this);
			const state = window.__ceraModemConfigSurface;
			if (state) {
				state.sendThrough = this.sendThrough;
			}
			this.addEventListener("message", (event: MessageEvent) => {
				const parsed = parseFrame(event.data);
				if (!isRecordFrame(parsed)) return;
				const directModems = parsed.modems;
				const status = parsed.status;
				const statusModems = isRecordFrame(status) ? status.modems : undefined;
				const modems = isRecordFrame(directModems)
					? directModems
					: statusModems;
				if (!isRecordFrame(modems)) return;
				const state = window.__ceraModemConfigSurface;
				if (state) state.lastModems = modems;
			});
		}

		override send(data: Parameters<WebSocket["send"]>[0]): void {
			const parsed = parseFrame(data);
			if (isRecordFrame(parsed) && Array.isArray(parsed.path)) {
				const path = parsed.path.every((part) => typeof part === "string")
					? parsed.path.join(".")
					: undefined;
				const state = window.__ceraModemConfigSurface;
				if (
					path &&
					state &&
					Object.prototype.hasOwnProperty.call(state.rpcFake, path)
				) {
					const result = state.rpcFake[path];
					const id = parsed.id;
					setTimeout(() => {
						this.dispatchEvent(
							new MessageEvent("message", {
								data: JSON.stringify({ id, result }),
							}),
						);
					}, 0);
					return;
				}
			}
			this.sendThrough(data);
		}
	}

	window.WebSocket = HookedWebSocket;
}

export function armFake(
	page: Page,
	path: string,
	result: unknown,
): Promise<void> {
	return page.evaluate(({ path: rpcPath, result: rpcResult }) => {
		const state = window.__ceraModemConfigSurface;
		if (!state) throw new Error("Cera modem harness is not installed");
		state.rpcFake[rpcPath] = rpcResult;
	}, { path, result });
}

export function targetModemKey(
	page: Page,
	modemIndex: number,
): Promise<string> {
	return page.evaluate((index) => {
		const keys = Object.keys(window.__ceraModemConfigSurface?.lastModems ?? {});
		const key = keys[index];
		if (!key) throw new Error(`no modem at index ${index} to patch`);
		return key;
	}, modemIndex);
}

export function openTargetModemDialog(
	page: Page,
	modemIndex: number,
): Promise<void> {
	return page.getByTestId("open-modem-config-dialog").nth(modemIndex).click();
}

export function patchModem(
	page: Page,
	key: string,
	patch: ModemPatch,
): Promise<void> {
	return page.evaluate(({ key: modemKey, patch: modemPatch }) => {
		function isRecordFrame(value: unknown): value is Record<string, unknown> {
			return typeof value === "object" && value !== null;
		}

		function parseFrame(value: unknown): unknown | undefined {
			try {
				const parsed: unknown = JSON.parse(String(value));
				return parsed;
			} catch (error) {
				if (error instanceof SyntaxError) return undefined;
				throw error;
			}
		}

		const modems = window.__ceraModemConfigSurface?.lastModems;
		const modem = modems?.[modemKey];
		if (!modems || !modem) throw new Error("no modem snapshot to patch");

		const clone = parseFrame(JSON.stringify(modem));
		if (!isRecordFrame(clone)) throw new Error("modem snapshot clone failed");

		for (const topKey of Object.keys(modemPatch)) {
			const patchValue = modemPatch[topKey];
			if (topKey === "config" || topKey === "network_type") {
				const existingValue = clone[topKey];
				clone[topKey] =
					isRecordFrame(existingValue) && isRecordFrame(patchValue)
						? { ...existingValue, ...patchValue }
						: patchValue;
			} else {
				clone[topKey] = patchValue;
			}
		}

		window.__ceraModemConfigSurface?.emit("modems", { [modemKey]: clone });
	}, { key, patch });
}

export function availableOperatorCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		function isRecordFrame(value: unknown): value is Record<string, unknown> {
			return typeof value === "object" && value !== null;
		}

		const modems = window.__ceraModemConfigSurface?.lastModems;
		if (!modems) return 0;

		let count = 0;
		for (const modem of Object.values(modems)) {
			if (!isRecordFrame(modem)) continue;
			const networks = modem.available_networks;
			if (!isRecordFrame(networks)) continue;
			for (const network of Object.values(networks)) {
				if (isRecordFrame(network) && network.availability === "available") {
					count++;
				}
			}
		}
		return count;
	});
}
