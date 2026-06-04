import type { Modem } from "../modems/modems-state.ts";
import type { WifiInterface } from "../wifi/wifi-interfaces.ts";

export type NetifState = Record<
	string,
	{
		ip?: string;
		mac?: string;
		up: boolean;
		tp: number;
		txb: number;
		error: number;
	}
>;

export type WifiState = Record<
	string,
	WifiInterface & { mode: "station" | "hotspot" }
>;

export type ModemsState = Record<number, Modem>;

export type StateDiff<T> = {
	added: T[];
	removed: T[];
	changed: T[];
};

export type MonitorEvent =
	| { type: "device-state"; device: string; state: string }
	| { type: "connection-state"; connection: string; state: string }
	| { type: "modem-added"; id: string }
	| { type: "modem-removed"; id: string };

export interface IMonitorEmitter {
	on(event: "monitor-event", cb: (e: MonitorEvent) => void): void;
	off(event: "monitor-event", cb: (e: MonitorEvent) => void): void;
	start(): void;
	stop(): void;
}
