import { writable } from '@macfja/svelte-persistent-store';

const themeStore = writable<'system' | 'dark' | 'light'>('theme', 'dark');

export { themeStore };
