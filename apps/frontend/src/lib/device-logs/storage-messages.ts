/**
 * The System Logs Storage section's messages: the shared catalogue, with the
 * word gaps of Chinese text marked (betweenWords) so a line never ends inside a
 * word. Every other language reads exactly as the catalogue has it.
 */
import { getLocale, m as messages } from "@ceraui/i18n/svelte";

import { betweenWords } from "./storage-readout";

type Message = (typeof messages)[string];

export const m: typeof messages = new Proxy(messages, {
	get(catalogue, key) {
		const message: Message | undefined = Reflect.get(catalogue, key);
		return (
			message &&
			((...args: Parameters<Message>) =>
				betweenWords(message(...args), getLocale()))
		);
	},
});
