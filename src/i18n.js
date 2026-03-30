/** Contract: i18n — locale detection from Accept-Language and translation lookup */

import en from './i18n/en.js';
import de from './i18n/de.js';

const translations = { en, de };
const SUPPORTED = Object.keys(translations);
const DEFAULT = 'en';

/** Parse Accept-Language header and return best supported locale. */
export function detectLocale(req) {
  const header = req.headers?.['accept-language'] || '';
  const langs = header.split(',').map(part => {
    const [lang, q] = part.trim().split(';q=');
    return { lang: lang.split('-')[0].toLowerCase(), q: q ? parseFloat(q) : 1 };
  }).sort((a, b) => b.q - a.q);

  for (const { lang } of langs) {
    if (SUPPORTED.includes(lang)) return lang;
  }
  return DEFAULT;
}

/** Return a translate function bound to a locale. t('key') or t('key', { name: 'val' }). */
export function t(locale) {
  const dict = translations[locale] || translations[DEFAULT];
  const fallback = translations[DEFAULT];

  return function _(key, params) {
    let str = dict[key] ?? fallback[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replaceAll(`{${k}}`, v);
      }
    }
    return str;
  };
}
