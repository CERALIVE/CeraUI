import { CerastreamConnectionError } from "@ceralive/cerastream";

const intentionalCloses = new WeakSet<object>();
let lossListener: ((site: string, proven: boolean) => void) | undefined;

export function bindEngineControlLoss(
	listener?: (site: string, proven: boolean) => void,
): void {
	lossListener = listener;
}

export function requestEngineReachabilityCheck(site: string): void {
	lossListener?.(site, false);
}

export function closeEngineControl(client: {
	close(): Promise<void>;
}): Promise<void> {
	intentionalCloses.add(client);
	return client.close();
}

export function isEngineControlLoss(
	error: unknown,
	client?: object,
): error is CerastreamConnectionError {
	return (
		error instanceof CerastreamConnectionError &&
		(client === undefined || !intentionalCloses.has(client))
	);
}

export function reportEngineControlLoss(
	error: unknown,
	origin: {
		readonly site: string;
		readonly client?: object;
		readonly current?: () => boolean;
	},
): void {
	if (
		!isEngineControlLoss(error, origin.client) ||
		origin.current?.() === false
	)
		return;
	lossListener?.(origin.site, true);
}
