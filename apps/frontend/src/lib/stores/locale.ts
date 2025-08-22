import { existingLocales } from "@ceraui/i18n";
import { writable } from "@macfja/svelte-persistent-store";

const localeStore = writable<(typeof existingLocales)[number]>(
	"locale",
	existingLocales[0],
);

export { localeStore };
