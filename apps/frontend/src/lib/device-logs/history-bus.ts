/**
 * Tells the System Logs regions that stored history was deleted, so each can
 * refresh what it shows. A plain listener set: it keeps no state of its own.
 */
type HistoryListener = () => void;

const registrations = new Set<{ listener: HistoryListener }>();

export function onHistoryChanged(listener: HistoryListener): () => void {
	const registration = { listener };
	registrations.add(registration);
	return () => {
		registrations.delete(registration);
	};
}

export function notifyHistoryChanged(): void {
	// A snapshot, so a listener that (un)subscribes cannot change this round.
	for (const { listener } of [...registrations]) {
		try {
			listener();
		} catch (error) {
			console.error("System Logs history listener failed:", error);
		}
	}
}
