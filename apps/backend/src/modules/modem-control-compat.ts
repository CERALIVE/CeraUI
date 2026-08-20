import * as modemControl from "@ceralive/modem-control";

const runtimeExports = modemControl as Readonly<Record<string, unknown>>;

export function modemControlFunction<T>(name: string, fallback: T): T {
	const candidate = runtimeExports[name];
	return typeof candidate === "function" ? (candidate as T) : fallback;
}

export function hasModemControlFunction(name: string): boolean {
	return typeof runtimeExports[name] === "function";
}
