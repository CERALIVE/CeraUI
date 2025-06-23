import { writable } from 'svelte/store';

import { defaultNavElement, type NavElements } from '$lib/config';

const navigationStore = writable<NavElements>(defaultNavElement);
export { navigationStore };
