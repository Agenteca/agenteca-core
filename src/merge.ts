import {
  applyEdits,
  type FormattingOptions,
  modify,
  parse as parseJsonc,
  type ParseError,
} from 'jsonc-parser';
import { parse as parseToml, stringify as tomlStringify } from 'smol-toml';
import { deepEqual } from './hash.js';
import type { MergedEntryRecord } from './lockfile.js';
import { t } from './i18n.js';

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

export interface MergeConflict {
  keyPath: string[];
  reason: 'foreign' | 'modified' | 'unreadable';
  message: string;
}

export interface MergeResult {
  /** Nouveau contenu du fichier. */
  text: string;
  /** Entrées dont le paquet est désormais propriétaire. */
  owned: MergedEntryRecord[];
  conflicts: MergeConflict[];
}

export interface RemoveResult {
  text: string;
  /** Entrées laissées en place parce qu'elles ont été modifiées à la main. */
  kept: MergedEntryRecord[];
}

function getIn(root: unknown, keyPath: string[]): unknown {
  let node = root;
  for (const k of keyPath) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[k];
  }
  return node;
}

function parseJson(text: string): { value: unknown; ok: boolean } {
  if (text.trim() === '') return { value: {}, ok: true };
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) return { value: undefined, ok: false };
  if (value === undefined) return { value: {}, ok: true };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { value, ok: false };
  return { value, ok: true };
}

function edit(text: string, jsonPath: Array<string | number>, value: unknown, insert = false): string {
  const base = text.trim() === '' ? '{}' : text;
  return applyEdits(
    base,
    modify(base, jsonPath, value, { formattingOptions: FORMAT, isArrayInsertion: insert }),
  );
}

function unreadable(): MergeConflict {
  return { keyPath: [], reason: 'unreadable', message: t('unreadable file (invalid JSON): left untouched') };
}

/**
 * Fusionne des entrées dans un document JSON (ou JSONC) par éditions ciblées :
 * contenu et commentaires existants sont conservés (seule l'indentation voisine
 * de l'édition peut être normalisée). Une clé déjà présente avec une autre
 * valeur n'est jamais écrasée.
 */
export function mergeJson(existing: string | undefined, entries: MergedEntryRecord[]): MergeResult {
  let text = existing ?? '';
  const owned: MergedEntryRecord[] = [];
  const conflicts: MergeConflict[] = [];
  if (!parseJson(text).ok) return { text, owned, conflicts: [unreadable()] };

  for (const entry of entries) {
    const current = getIn(parseJson(text).value, entry.keyPath);
    if (entry.type === 'ensure') {
      if (current === undefined) text = edit(text, entry.keyPath, entry.value);
      owned.push(entry);
    } else if (entry.type === 'key') {
      if (current === undefined) {
        text = edit(text, entry.keyPath, entry.value);
        owned.push(entry);
      } else if (deepEqual(current, entry.value)) {
        owned.push(entry); // valeur identique déjà présente : adoptée
      } else {
        conflicts.push({
          keyPath: entry.keyPath,
          reason: 'foreign',
          message: t('"{0}" already exists with a different value', [entry.keyPath.join('.')]),
        });
      }
    } else if (entry.type === 'append') {
      if (current !== undefined && !Array.isArray(current)) {
        conflicts.push({
          keyPath: entry.keyPath,
          reason: 'foreign',
          message: t('"{0}" is not a list', [entry.keyPath.join('.')]),
        });
        continue;
      }
      const already = Array.isArray(current) && current.some((item) => deepEqual(item, entry.value));
      if (!already) {
        text =
          current === undefined
            ? edit(text, entry.keyPath, [entry.value])
            : edit(text, [...entry.keyPath, -1], entry.value, true);
      }
      owned.push(entry);
    }
  }
  if (text !== '' && !text.endsWith('\n')) text += '\n';
  return { text, owned, conflicts };
}

/** Retire d'un document JSON les entrées possédées, si elles n'ont pas été modifiées. */
export function unmergeJson(existing: string, ownedEntries: MergedEntryRecord[]): RemoveResult {
  let text = existing;
  const kept: MergedEntryRecord[] = [];
  if (!parseJson(text).ok) return { text, kept: ownedEntries.filter((e) => e.type !== 'ensure') };

  for (const entry of ownedEntries) {
    if (entry.type === 'ensure') continue;
    const current = getIn(parseJson(text).value, entry.keyPath);
    if (current === undefined) continue;
    if (entry.type === 'key') {
      if (deepEqual(current, entry.value)) text = edit(text, entry.keyPath, undefined);
      else kept.push(entry);
    } else if (entry.type === 'append' && Array.isArray(current)) {
      const index = current.findIndex((item) => deepEqual(item, entry.value));
      if (index >= 0) text = edit(text, [...entry.keyPath, index], undefined);
      // élément absent : déjà retiré à la main, rien à faire
    }
    // Élagage : conteneurs devenus vides le long du chemin touché.
    for (let depth = entry.keyPath.length - (entry.type === 'key' ? 1 : 0); depth >= 1; depth--) {
      const parentPath = entry.keyPath.slice(0, depth);
      const parent = getIn(parseJson(text).value, parentPath);
      const empty =
        (Array.isArray(parent) && parent.length === 0) ||
        (parent !== null &&
          typeof parent === 'object' &&
          !Array.isArray(parent) &&
          Object.keys(parent).length === 0);
      if (!empty) break;
      text = edit(text, parentPath, undefined);
    }
  }
  return { text, kept };
}

/** Vrai si le document ne contient plus que des clés « ensure » (ou rien). */
export function jsonIsEffectivelyEmpty(text: string, ensured: MergedEntryRecord[]): boolean {
  const parsed = parseJson(text);
  if (!parsed.ok) return false;
  const obj = parsed.value as Record<string, unknown>;
  const ensureKeys = new Set(
    ensured.filter((e) => e.type === 'ensure' && e.keyPath.length === 1).map((e) => e.keyPath[0]),
  );
  return Object.keys(obj).every((k) => ensureKeys.has(k));
}

// ---------------------------------------------------------------------------
// TOML : les entrées vivent dans un bloc délimité, le reste du fichier n'est jamais réécrit.

function markers(blockId: string): { start: string; end: string } {
  return {
    start: `# >>> ahub: ${blockId} (managed by ahub — do not edit; open a new table before adding anything below)`,
    end: `# <<< ahub: ${blockId}`,
  };
}

function splitBlock(
  text: string,
  blockId: string,
): { before: string; block: string | undefined; after: string } {
  const startPrefix = `# >>> ahub: ${blockId} `;
  const { end } = markers(blockId);
  const lines = text.split('\n');
  const s = lines.findIndex((l) => l.startsWith(startPrefix) || l === startPrefix.trimEnd());
  if (s === -1) return { before: text, block: undefined, after: '' };
  const e = lines.findIndex((l, i) => i > s && l.trim() === end);
  if (e === -1) return { before: text, block: undefined, after: '' };
  return {
    before: lines.slice(0, s).join('\n'),
    block: lines.slice(s + 1, e).join('\n'),
    after: lines.slice(e + 1).join('\n'),
  };
}

function renderTomlEntries(entries: MergedEntryRecord[]): string {
  return entries
    .map((e) => {
      let nested: Record<string, unknown> = e.value as Record<string, unknown>;
      for (let i = e.keyPath.length - 1; i >= 0; i--) nested = { [e.keyPath[i]!]: nested };
      return tomlStringify(nested).trim();
    })
    .join('\n\n');
}

function joinToml(before: string, block: string | undefined, after: string, blockId: string): string {
  const parts: string[] = [];
  const b = before.replace(/\s+$/, '');
  if (b) parts.push(b);
  if (block !== undefined && block.trim() !== '') {
    const { start, end } = markers(blockId);
    parts.push(`${start}\n${block.trim()}\n${end}`);
  }
  const a = after.replace(/^\s+|\s+$/g, '');
  if (a) parts.push(a);
  return parts.length > 0 ? parts.join('\n\n') + '\n' : '';
}

/** Écrit (ou remplace) le bloc TOML d'un paquet. */
export function mergeToml(
  existing: string | undefined,
  blockId: string,
  entries: MergedEntryRecord[],
  previouslyOwned: MergedEntryRecord[],
): MergeResult {
  const text = existing ?? '';
  const { before, block, after } = splitBlock(text, blockId);
  const conflicts: MergeConflict[] = [];

  if (
    block !== undefined &&
    previouslyOwned.length > 0 &&
    block.trim() !== renderTomlEntries(previouslyOwned).trim()
  ) {
    return {
      text,
      owned: previouslyOwned,
      conflicts: [
        {
          keyPath: [],
          reason: 'modified',
          message: t('the managed block "{0}" was edited by hand', [blockId]),
        },
      ],
    };
  }
  let outside: unknown;
  try {
    outside = parseToml(`${before}\n${after}`);
  } catch {
    return {
      text,
      owned: [],
      conflicts: [
        { keyPath: [], reason: 'unreadable', message: t('unreadable file (invalid TOML): left untouched') },
      ],
    };
  }
  const owned: MergedEntryRecord[] = [];
  for (const entry of entries) {
    const current = getIn(outside, entry.keyPath);
    if (current === undefined) owned.push(entry);
    else if (!deepEqual(current, entry.value)) {
      conflicts.push({
        keyPath: entry.keyPath,
        reason: 'foreign',
        message: t('"{0}" already exists with a different value', [entry.keyPath.join('.')]),
      });
    }
    // valeur identique hors bloc : déjà configurée par l'utilisateur, rien à écrire ni à posséder
  }
  return { text: joinToml(before, renderTomlEntries(owned), after, blockId), owned, conflicts };
}

/** Retire le bloc TOML d'un paquet, sauf s'il a été modifié à la main. */
export function unmergeToml(
  existing: string,
  blockId: string,
  ownedEntries: MergedEntryRecord[],
): RemoveResult {
  const { before, block, after } = splitBlock(existing, blockId);
  if (block === undefined) return { text: existing, kept: [] };
  if (ownedEntries.length > 0 && block.trim() !== renderTomlEntries(ownedEntries).trim()) {
    return { text: existing, kept: ownedEntries };
  }
  return { text: joinToml(before, undefined, after, blockId), kept: [] };
}
