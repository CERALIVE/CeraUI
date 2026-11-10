import type { BaseWifiInterface } from "./wifi-interfaces.ts";
import type { RadioIdentity } from "./wifi-radio-identity.ts";

const observationByRow = new WeakMap<
	BaseWifiInterface,
	number | symbol | undefined
>();

export function invalidateWifiRadioRow(
	row: BaseWifiInterface,
	observation: number | undefined,
): void {
	observationByRow.set(row, observation);
}

export function suspendWifiRadioRow(row: BaseWifiInterface): () => void {
	const previous = observationByRow.get(row);
	const suspended = Symbol();
	observationByRow.set(row, suspended);
	return () => {
		if (observationByRow.get(row) === suspended) {
			observationByRow.set(row, previous);
		}
	};
}

export function projectWifiRadioIncarnation(
	row: BaseWifiInterface,
	evidence: RadioIdentity | undefined,
): string | undefined {
	return evidence?.row === row &&
		evidence.lifetime !== undefined &&
		evidence.observation !== undefined &&
		observationByRow.get(row) === evidence.observation
		? evidence.incarnation
		: undefined;
}
