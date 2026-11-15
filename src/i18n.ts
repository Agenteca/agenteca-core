/**
 * Translation of user-facing messages.
 *
 * English is the source language: the code calls `t('English text with {0}', [value])` and each
 * catalog maps that exact English text to its translation. A message with no translation is shown
 * in English, so a missing entry is never an error at run time; `test/i18n.test.ts` is what keeps
 * the catalogs complete.
 *
 * Nothing written to disk by a deployment is ever translated: file contents must not depend on the
 * language of whoever ran the command.
 */
import es from './locales/es.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };
import hi from './locales/hi.json' with { type: 'json' };
import zh from './locales/zh.json' with { type: 'json' };

export const LOCALES = ['en', 'fr', 'es', 'zh', 'hi'] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageCatalog = Readonly<Record<string, string>>;
export type Translator = (message: string, args?: readonly unknown[]) => string;

const catalogs = new Map<Locale, Map<string, string>>();
let current: Locale = 'en';

/** Add translations for a language. Other packages (CLI, MCP server…) register their own messages this way. */
export function registerCatalog(locale: Locale, entries: MessageCatalog): void {
  if (locale === 'en') return;
  let catalog = catalogs.get(locale);
  if (!catalog) {
    catalog = new Map();
    catalogs.set(locale, catalog);
  }
  for (const [source, translation] of Object.entries(entries)) catalog.set(source, translation);
}

registerCatalog('fr', fr);
registerCatalog('es', es);
registerCatalog('zh', zh);
registerCatalog('hi', hi);

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

/** "fr_FR.UTF-8", "zh-Hans-CN", "ES" → a supported language, or undefined ("C", "POSIX", "de_DE"…). */
export function parseLocale(value: string | undefined): Locale | undefined {
  if (!value) return undefined;
  const language = value
    .trim()
    .toLowerCase()
    .split(/[_.\-@]/)[0];
  return (LOCALES as readonly string[]).includes(language ?? '') ? (language as Locale) : undefined;
}

/**
 * Language to use, from the environment: AHUB_LANG first, then the POSIX variables in their usual
 * order of precedence. The first variable that is set decides; an unsupported value means English.
 */
export function detectLocale(env: Readonly<Record<string, string | undefined>> = process.env): Locale {
  for (const name of ['AHUB_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[name];
    if (value) return parseLocale(value) ?? 'en';
  }
  return 'en';
}

/** Replace `{0}`, `{1}`… with the given values. An index with no value is left as written. */
export function formatMessage(message: string, args: readonly unknown[] = []): string {
  if (args.length === 0) return message;
  return message.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const i = Number(index);
    return i < args.length ? String(args[i]) : placeholder;
  });
}

/** A translator bound to one language, for code that serves several languages at once (a web server). */
export function createTranslator(locale: Locale): Translator {
  const catalog = catalogs.get(locale);
  return (message, args = []) => formatMessage(catalog?.get(message) ?? message, args);
}

/** Translate a message into the current language. `message` must be a literal: it is the catalog key. */
export function t(message: string, args: readonly unknown[] = []): string {
  return formatMessage(catalogs.get(current)?.get(message) ?? message, args);
}

/**
 * Mark a message for translation without translating it yet. For text defined when a module loads
 * (tables of rules, constants), before the language is known: pass the value to `t()` when it is shown.
 */
export function msg(message: string): string {
  return message;
}
