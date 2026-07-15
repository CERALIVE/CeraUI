/** Minimal socket surface used by direct backend message producers. */
export interface MessageSocket {
	readonly data?: {
		readonly senderId?: string;
	};
	send(message: string): void;
}
