import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCALES,
  createTranslator,
  detectLocale,
  formatMessage,
  getLocale,
  parseLocale,
  setLocale,
  t,
} from '../src/i18n.js';
import { RULES, scanFile } from '../src/scan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'locales' ? [] : sourceFiles(p);
    return e.name.endsWith('.ts') && e.name !== 'i18n.ts' ? [p] : [];
  });
}

/** Every message passed as a literal to t() or msg() in the sources. */
function sourceMessages(): Set<string> {
  const found = new Set<string>();
  const call = /\b(?:t|msg)\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g;
  for (const file of sourceFiles(srcDir)) {
    for (const m of readFileSync(file, 'utf8').matchAll(call)) {
      const literal = m[1]!;
      const body = literal.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
      found.add(body);
    }
  }
  return found;
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();

describe('translations', () => {
  afterEach(() => setLocale('en'));

  const messages = sourceMessages();
  const translated = LOCALES.filter((l) => l !== 'en');

  it('finds the messages of the sources', () => {
    expect(messages.size).toBeGreaterThan(150);
  });

  it.each(translated)('catalog %s translates every message and nothing else', (locale) => {
    const catalog = JSON.parse(
      readFileSync(path.join(srcDir, 'locales', `${locale}.json`), 'utf8'),
    ) as Record<string, string>;
    const keys = new Set(Object.keys(catalog));
    expect(
      [...messages].filter((m) => !keys.has(m)),
      'messages with no translation',
    ).toEqual([]);
    expect(
      [...keys].filter((k) => !messages.has(k)),
      'translations of messages that no longer exist',
    ).toEqual([]);
    for (const [source, translation] of Object.entries(catalog)) {
      expect(translation.trim(), source).not.toBe('');
      expect(placeholders(translation), source).toEqual(placeholders(source));
    }
  });

  it('catalogs are sorted, so that changes stay easy to review', () => {
    for (const locale of translated) {
      const keys = Object.keys(
        JSON.parse(readFileSync(path.join(srcDir, 'locales', `${locale}.json`), 'utf8')),
      );
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('formats positional values', () => {
    expect(formatMessage('{1} then {0} then {1}', ['a', 'b'])).toBe('b then a then b');
    expect(formatMessage('{0} and {3}', ['a'])).toBe('a and {3}');
    expect(formatMessage('nothing {0}')).toBe('nothing {0}');
  });

  it('translates into the current language and falls back to English', () => {
    expect(getLocale()).toBe('en');
    expect(t('unknown target "{0}"', ['x'])).toBe('unknown target "x"');
    setLocale('fr');
    expect(t('unknown target "{0}"', ['x'])).toBe('cible inconnue « x »');
    expect(t('a message nobody translated {0}', [1])).toBe('a message nobody translated 1');
    expect(createTranslator('es')('unknown target "{0}"', ['x'])).toBe('destino desconocido «x»');
    expect(createTranslator('zh')('empty string')).toBe('空字符串');
    expect(createTranslator('hi')('empty string')).toBe('खाली स्ट्रिंग');
  });

  it('translates rule texts when they are shown, not when the module loads', () => {
    expect(RULES[0]!.description).toMatch(/^Characters from the Unicode/);
    setLocale('fr');
    const [finding] = scanFile({ path: 'a.md', bytes: Buffer.from(`x${String.fromCodePoint(0xe0041)}\n`) });
    expect(finding!.message).toMatch(/^Caractères du bloc Unicode/);
  });

  it('reads the language from the environment', () => {
    expect(parseLocale('fr_FR.UTF-8')).toBe('fr');
    expect(parseLocale('zh-Hans-CN')).toBe('zh');
    expect(parseLocale('ES')).toBe('es');
    expect(parseLocale('C')).toBeUndefined();
    expect(parseLocale('de_DE.UTF-8')).toBeUndefined();
    expect(detectLocale({})).toBe('en');
    expect(detectLocale({ LANG: 'hi_IN.UTF-8' })).toBe('hi');
    expect(detectLocale({ LANG: 'fr_FR.UTF-8', LC_ALL: 'C' })).toBe('en');
    expect(detectLocale({ LANG: 'fr_FR.UTF-8', AHUB_LANG: 'es' })).toBe('es');
  });
});
