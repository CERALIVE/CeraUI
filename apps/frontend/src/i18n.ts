import { addMessages, getLocaleFromNavigator, init } from 'svelte-i18n';

import ar from './locale/ar.json';
import de from './locale/de.json';
import en from './locale/en.json';
import es from './locale/es.json';
import fr from './locale/fr.json';
import hi from './locale/hi.json';
import ja from './locale/ja.json';
import ko from './locale/ko.json';
import ptBr from './locale/pt-BR.json';
import zh from './locale/zh.json';

export type DefinedLocales = Array<{ name: string; file: string; code: string }>;

addMessages('en', en);
addMessages('es', es);
addMessages('pt-BR', ptBr);
addMessages('fr', fr);
addMessages('de', de);
addMessages('zh', zh);
addMessages('hi', hi);
addMessages('ar', ar);
addMessages('ja', ja);
addMessages('ko', ko);

export const existingLocales: DefinedLocales = [
  { name: 'English', file: './locale/en.json', code: 'en' },
  { name: 'Español', file: './locale/es.json', code: 'es' },
  { name: 'Português', file: './locale/pt-BR.json', code: 'pt-BR' },
  { name: 'Français', file: './locale/fr.json', code: 'fr' },
  { name: 'Deutsch', file: './locale/de.json', code: 'de' },
  { name: '中文', file: './locale/zh.json', code: 'zh' },
  { name: 'العربية', file: './locale/ar.json', code: 'ar' },
  { name: '日本語', file: './locale/ja.json', code: 'ja' },
  { name: '한국어', file: './locale/ko.json', code: 'ko' },
  { name: 'हिन्दी', file: './locale/hi.json', code: 'hi' },
];

export const rtlLanguages = [
  'ar', // Arabic - most common RTL
  'he', // Hebrew
  'fa', // Persian/Farsi
  'ur', // Urdu
];

export async function setupLocale() {
  return await Promise.allSettled([
    init({
      fallbackLocale: 'en',
      initialLocale: getLocaleFromNavigator(),
    }),
  ]);
}
