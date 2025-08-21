import { writable } from "@macfja/svelte-persistent-store";

import { existingLocales } from "@ceraui/i18n";

const localeStore = writable<typeof existingLocales[number]>(
	"locale",
	existingLocales[0],
);

export { localeStore };
