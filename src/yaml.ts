import { type Document, isAlias, isNode, parseDocument, stringify, visit } from 'yaml';
import { AhubError, type ErrorCode } from './errors.js';

const STD_TAG_PREFIX = 'tag:yaml.org,2002:';

/**
 * Analyse un document YAML sous le sous-ensemble sûr d'OpenAPM (req-mf-020) :
 * YAML 1.2 (pas de coercition octale 1.1), ancres et alias refusés, tags
 * personnalisés refusés.
 */
export function parseYamlDocument(
  text: string,
  file: string,
  code: ErrorCode = 'MANIFEST_INVALID',
): Document {
  const doc = parseDocument(text, {
    version: '1.2',
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    prettyErrors: true,
  });
  if (doc.errors.length > 0) {
    throw new AhubError(code, `${file} : YAML invalide — ${doc.errors[0]!.message}`, { file });
  }
  for (const w of doc.warnings) {
    if (/tag/i.test(w.message)) {
      throw new AhubError(code, `${file} : tag YAML personnalisé refusé — ${w.message}`, { file });
    }
  }
  visit(doc, {
    Alias() {
      throw new AhubError(code, `${file} : les alias YAML (*alias) sont refusés`, { file });
    },
    Node(_key, node) {
      if (isAlias(node)) return;
      if (isNode(node)) {
        if (node.anchor) {
          throw new AhubError(code, `${file} : les ancres YAML (&${node.anchor}) sont refusées`, { file });
        }
        if (node.tag && !node.tag.startsWith(STD_TAG_PREFIX) && node.tag !== '!' && node.tag !== '?') {
          throw new AhubError(code, `${file} : tag YAML personnalisé refusé (${node.tag})`, { file });
        }
      }
    },
  });
  return doc;
}

/** Analyse en objet JavaScript simple, sous le même sous-ensemble sûr. */
export function parseYamlSafe(text: string, file: string, code: ErrorCode = 'MANIFEST_INVALID'): unknown {
  return parseYamlDocument(text, file, code).toJS({ maxAliasCount: 0 });
}

export function stringifyYaml(value: unknown): string {
  return stringify(value, { version: '1.2', lineWidth: 0, aliasDuplicateObjects: false });
}

/** Sépare le frontmatter YAML du corps d'un fichier Markdown. */
export function splitFrontmatter(
  text: string,
  file: string,
): { frontmatter: Record<string, unknown> | null; body: string; error?: string } {
  const src = text.replace(/^\uFEFF/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { frontmatter: null, body: src };
  const body = src.slice(m[0].length);
  try {
    const data = parseYamlSafe(m[1]!, file, 'PACKAGE_INVALID');
    if (data === null || data === undefined) return { frontmatter: {}, body };
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { frontmatter: null, body, error: 'le frontmatter n’est pas un dictionnaire' };
    }
    return { frontmatter: data as Record<string, unknown>, body };
  } catch (e) {
    return { frontmatter: null, body, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Reconstruit un fichier Markdown avec frontmatter (clés non définies omises). */
export function withFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== undefined && v !== null) clean[k] = v;
  }
  const b = body.replace(/^\r?\n+/, '');
  if (Object.keys(clean).length === 0) return b;
  return `---\n${stringifyYaml(clean)}---\n\n${b}`;
}
