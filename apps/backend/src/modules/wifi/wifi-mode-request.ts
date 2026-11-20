import { AsyncLocalStorage } from "node:async_hooks";
import type { AdapterModeRefusalPublisher } from "./wifi-adapter-mode-outcome.ts";

type ModeRequest = { publish: AdapterModeRefusalPublisher | undefined };
const requests = new AsyncLocalStorage<ModeRequest>();

/** Only the request's first mode transaction can claim its entry reply. */
export function takeWifiModeRequestRefusal():
	| AdapterModeRefusalPublisher
	| undefined {
	const request = requests.getStore();
	const publish = request?.publish;
	if (request) request.publish = undefined;
	return publish;
}

export async function withWifiModeRequestRefusal<T>(
	publish: AdapterModeRefusalPublisher,
	operation: () => Promise<T>,
): Promise<T> {
	const request: ModeRequest = { publish };
	try {
		return await requests.run(request, operation);
	} finally {
		request.publish = undefined;
	}
}
