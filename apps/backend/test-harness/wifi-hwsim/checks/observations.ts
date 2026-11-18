import { nmcliParseSep } from '../../../src/modules/network/network-manager-output.ts';

export type WifiRow = {
	readonly device: string;
	readonly type: string;
	readonly state: string;
	readonly connection: string | undefined;
};

export function wifiRows(text: string): readonly WifiRow[] {
	return text
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [device = '', type = '', state = '', connection] = nmcliParseSep(line);
			return { device, type, state, connection };
		});
}

const managedStates = new Set([
	'disconnected',
	'connecting',
	'connected',
	'disconnecting',
	'failed',
]);

export function managedWifiState(text: string, device: string): string | undefined {
	return wifiRows(text).find(
		(row) =>
			row.device === device &&
			row.type === 'wifi' &&
			managedStates.has(row.state.split(' ')[0] ?? ''),
	)?.state;
}

/** Connected is NM device state 100; disconnected must never match by substring. */
export function bootstrapAssociated(text: string, device: string): boolean {
	return wifiRows(text).some(
		(row) =>
			row.device === device &&
			row.type === 'wifi' &&
			row.state.split(' ')[0] === 'connected' &&
			row.connection === 'CeraTest',
	);
}

export type PhyObservation = {
	readonly modes: readonly string[];
	readonly frequencies: readonly {
		readonly mhz: number;
		readonly channel: number;
		readonly flags: string;
	}[];
};

export function decodeIwPhy(text: string): PhyObservation {
	const modes: string[] = [];
	const frequencies: { mhz: number; channel: number; flags: string }[] = [];
	let modeSection = false;
	for (const line of text.split('\n')) {
		if (line.trim() === 'Supported interface modes:') {
			modeSection = true;
			continue;
		}
		if (modeSection) {
			const mode = /^\s+\*\s+(.+?)\s*$/.exec(line)?.[1];
			if (mode) modes.push(mode);
			else modeSection = false;
		}
		const match = /^\s*\*\s+(\d+(?:[.]\d+)?)\s+MHz\s+\[(\d+)\](.*)$/.exec(line);
		const [, mhz, channel, flags] = match ?? [];
		if (mhz === undefined || channel === undefined || flags === undefined) continue;
		const frequency = Number(mhz);
		const number = Number(channel);
		if (Number.isFinite(frequency) && Number.isSafeInteger(number))
			frequencies.push({ mhz: frequency, channel: number, flags });
	}
	return { modes, frequencies };
}

/** Render decoded fields for the unchanged native assertions, preserving channel flags. */
export function canonicalIwPhy(text: string): string {
	const observation = decodeIwPhy(text);
	return [
		...(observation.modes.includes('AP') ? ['* AP'] : []),
		...observation.frequencies.map((row) => `${row.mhz} MHz [${row.channel}]${row.flags}`),
	].join('\n');
}
