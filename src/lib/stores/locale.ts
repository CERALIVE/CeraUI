import { writable } from '@macfja/svelte-persistent-store';

import { type DefinedLocales, existingLocales } from '../../i18n';

const localeStore = writable<DefinedLocales[number]>('locale', existingLocales[0]);

export { localeStore };
