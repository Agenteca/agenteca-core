import { cloneUrl, type DepRef, parseDepString } from './depref.js';
import type { Diagnostic } from './errors.js';

/** Entrée de catalogue normalisée, indépendante du format de marketplace. */
export interface CatalogEntry {
  name: string;
  description?: string;
  version?: string;
  /** Référence installable par `ahub add` (forme OpenAPM). */
  source: string;
  license?: string;
  author?: string;
  homepage?: string;
  category?: string;
  tags?: string[];
  /** Outils compatibles (claude, codex, copilot, cursor). */
  tools?: string[];
  /** Le dépôt a aussi la disposition d'un plugin natif (installable par les outils eux-mêmes). */
  nativePlugin?: boolean;
}

export interface Catalog {
  name: string;
  description?: string;
  owner?: { name: string; url?: string; email?: string };
  entries: CatalogEntry[];
}

export type MarketplaceFormat = 'claude' | 'codex' | 'copilot' | 'cursor';

/** Emplacement du fichier de marketplace pour chaque outil. */
export const MARKETPLACE_PATHS: Record<MarketplaceFormat, string> = {
  claude: '.claude-plugin/marketplace.json',
  codex: '.agents/plugins/marketplace.json',
  copilot: '.github/plugin/marketplace.json',
  cursor: '.cursor-plugin/marketplace.json',
};

/** Ordre de recherche d'un marketplace dans un dépôt (celui d'APM, étendu aux formats Codex et Cursor). */
export const MARKETPLACE_SEARCH_ORDER = [
  'marketplace.json',
  '.github/plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
  '.cursor-plugin/marketplace.json',
];

export interface MarketplaceContext {
  /** Référence du dépôt qui publie le marketplace (`propriétaire/dépôt`), pour les sources relatives. */
  baseRepo?: string;
  baseRef?: string;
  /** Dossier local du marketplace, pour les sources relatives d'un registre de type chemin. */
  baseDir?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function withRef(base: string, ref: string | undefined): string {
  return ref ? `${base}#${ref}` : base;
}

/** Convertit la « source » d'une entrée de marketplace en référence OpenAPM. */
export function sourceToDep(
  source: unknown,
  pluginRoot: string | undefined,
  ctx: MarketplaceContext,
): string | undefined {
  const relative = (p: string): string | undefined => {
    let rel = p.replace(/^\.\//, '').replace(/\/+$/, '');
    if (pluginRoot && !p.startsWith('./') && !p.startsWith('/'))
      rel = `${pluginRoot.replace(/^\.\//, '').replace(/\/+$/, '')}/${rel}`;
    if (rel.split('/').includes('..')) return undefined;
    if (ctx.baseDir) return rel ? `${ctx.baseDir.replace(/\/+$/, '')}/${rel}` : ctx.baseDir;
    if (ctx.baseRepo) return withRef(rel ? `${ctx.baseRepo}/${rel}` : ctx.baseRepo, ctx.baseRef);
    return undefined;
  };
  if (typeof source === 'string') return relative(source);
  if (source === null || typeof source !== 'object') return undefined;
  const s = source as Record<string, unknown>;
  const ref = str(s.sha) ?? str(s.ref);
  const sub = str(s.path)?.replace(/^\.?\/+|\/+$/g, '');
  switch (s.source) {
    case 'github': {
      const repo = str(s.repo);
      return repo ? withRef(sub ? `${repo}/${sub}` : repo, ref) : undefined;
    }
    case 'url':
    case 'git':
    case 'git-subdir': {
      const url = str(s.url)?.replace(/\.git$/, '');
      return url ? withRef(sub ? `${url}/${sub}` : url, ref) : undefined;
    }
    case 'local':
      return sub !== undefined || str(s.path) ? relative(str(s.path)!) : undefined;
    default:
      return str(s.path) ? relative(str(s.path)!) : undefined;
  }
}

/**
 * Lit un marketplace.json aux formats Claude Code, Copilot CLI, Codex ou Cursor.
 * Les entrées dont la source n'est pas exprimable (npm, archive, commande) sont
 * écartées avec un diagnostic.
 */
export function parseMarketplace(
  json: unknown,
  ctx: MarketplaceContext = {},
): { catalog: Catalog; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const root = (json ?? {}) as Record<string, unknown>;
  const iface = (root.interface ?? {}) as Record<string, unknown>;
  const metadata = (root.metadata ?? {}) as Record<string, unknown>;
  const catalog: Catalog = { name: str(root.name) ?? str(iface.displayName) ?? 'marketplace', entries: [] };
  const description = str(root.description) ?? str(metadata.description);
  if (description) catalog.description = description;
  if (root.owner && typeof root.owner === 'object') {
    const o = root.owner as Record<string, unknown>;
    if (str(o.name)) {
      catalog.owner = { name: str(o.name)! };
      if (str(o.url)) catalog.owner.url = str(o.url)!;
      if (str(o.email)) catalog.owner.email = str(o.email)!;
    }
  }
  const plugins = Array.isArray(root.plugins) ? root.plugins : [];
  for (const raw of plugins) {
    if (raw === null || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const name = str(p.name);
    if (!name) continue;
    const source = sourceToDep(p.source, str(metadata.pluginRoot), ctx);
    if (!source) {
      diagnostics.push({
        code: 'MARKETPLACE_SOURCE_UNSUPPORTED',
        message: `« ${name} » : type de source non pris en charge, entrée ignorée`,
      });
      continue;
    }
    const entry: CatalogEntry = { name, source, nativePlugin: true };
    if (str(p.description)) entry.description = str(p.description)!;
    if (str(p.version)) entry.version = str(p.version)!;
    if (str(p.license)) entry.license = str(p.license)!;
    if (str(p.homepage)) entry.homepage = str(p.homepage)!;
    if (str(p.category)) entry.category = str(p.category)!;
    const author =
      p.author && typeof p.author === 'object'
        ? str((p.author as Record<string, unknown>).name)
        : str(p.author);
    if (author) entry.author = author;
    const tags = Array.isArray(p.tags) ? p.tags : Array.isArray(p.keywords) ? p.keywords : undefined;
    if (tags) entry.tags = tags.map(String);
    catalog.entries.push(entry);
  }
  return { catalog, diagnostics };
}

function claudeSource(ref: DepRef): unknown {
  if (ref.kind === 'local') return ref.localPath!.startsWith('./') ? ref.localPath : `./${ref.localPath}`;
  const pin = ref.ref ? (/^[0-9a-f]{40}$/.test(ref.ref) ? { sha: ref.ref } : { ref: ref.ref }) : {};
  const url = cloneUrl(ref);
  if (ref.virtualPath) return { source: 'git-subdir', url, path: ref.virtualPath, ...pin };
  if (ref.host === 'github.com') return { source: 'github', repo: `${ref.owner}/${ref.repo}`, ...pin };
  return { source: 'url', url, ...pin };
}

export interface ExportResult {
  path: string;
  json: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

/**
 * Exporte un catalogue au format de marketplace natif d'un outil. Par défaut,
 * seules les entrées dont le dépôt est aussi un plugin natif sont exportées :
 * les outils ne savent installer que cette disposition.
 */
export function exportMarketplace(
  catalog: Catalog,
  format: MarketplaceFormat,
  opts: { includeAll?: boolean } = {},
): ExportResult {
  const diagnostics: Diagnostic[] = [];
  const plugins: unknown[] = [];
  for (const e of catalog.entries) {
    if (!opts.includeAll && e.nativePlugin !== true) {
      diagnostics.push({
        code: 'EXPORT_NOT_NATIVE_PLUGIN',
        message: `« ${e.name} » n’a pas la disposition d’un plugin natif : non exporté (installable par ahub ou apm)`,
      });
      continue;
    }
    // Un plugin natif ne vaut que pour son outil : il n'apparaît pas dans le marketplace des autres.
    if (e.nativePlugin === true && e.tools && e.tools.length > 0 && !e.tools.includes(format)) continue;
    let ref: DepRef;
    try {
      ref = parseDepString(e.source);
    } catch {
      diagnostics.push({
        code: 'EXPORT_SOURCE_INVALID',
        message: `« ${e.name} » : source « ${e.source} » non exportable`,
      });
      continue;
    }
    const common: Record<string, unknown> = { name: e.name };
    if (e.description) common.description = e.description;
    if (e.version) common.version = e.version;

    if (format === 'codex') {
      // Schéma Codex : pas d'`owner`, une `policy` par entrée. Champs de la source `url` non confirmés par la doc.
      const src =
        ref.kind === 'local'
          ? { source: 'local', path: ref.localPath }
          : ref.virtualPath
            ? {
                source: 'git-subdir',
                url: cloneUrl(ref),
                path: ref.virtualPath,
                ...(ref.ref ? { ref: ref.ref } : {}),
              }
            : { source: 'url', url: cloneUrl(ref), ...(ref.ref ? { ref: ref.ref } : {}) };
      plugins.push({
        ...common,
        source: src,
        policy: { installation: 'AVAILABLE' },
        ...(e.category ? { category: e.category } : {}),
      });
    } else if (format === 'cursor') {
      if (ref.kind !== 'local') {
        diagnostics.push({
          code: 'EXPORT_CURSOR_LOCAL_ONLY',
          message: `« ${e.name} » : Cursor ne documente que des sources locales, entrée non exportée`,
        });
        continue;
      }
      plugins.push({ ...common, source: ref.localPath });
    } else {
      const src =
        format === 'copilot' && ref.kind === 'git' && ref.virtualPath && ref.host === 'github.com'
          ? {
              source: 'github',
              repo: `${ref.owner}/${ref.repo}`,
              path: ref.virtualPath,
              ...(ref.ref ? { ref: ref.ref } : {}),
            }
          : claudeSource(ref);
      const entry: Record<string, unknown> = { ...common, source: src };
      if (e.author) entry.author = { name: e.author };
      if (e.license) entry.license = e.license;
      if (e.homepage) entry.homepage = e.homepage;
      if (e.category) entry.category = e.category;
      if (e.tags && e.tags.length > 0) entry.keywords = e.tags;
      plugins.push(entry);
    }
  }
  const json: Record<string, unknown> =
    format === 'codex'
      ? { name: catalog.name, interface: { displayName: catalog.description ?? catalog.name }, plugins }
      : {
          name: catalog.name,
          owner: catalog.owner ?? { name: catalog.name },
          ...(catalog.description ? { metadata: { description: catalog.description } } : {}),
          plugins,
        };
  return { path: MARKETPLACE_PATHS[format], json, diagnostics };
}

/** Lit le bloc `marketplace:` d'un `apm.yml` (spec §4.7) comme catalogue. */
export function catalogFromManifestBlock(block: unknown, fallbackName: string): Catalog {
  const b = (block ?? {}) as Record<string, unknown>;
  const catalog: Catalog = { name: str(b.name) ?? fallbackName, entries: [] };
  if (str(b.description)) catalog.description = str(b.description)!;
  if (b.owner && typeof b.owner === 'object') {
    const o = b.owner as Record<string, unknown>;
    if (str(o.name)) {
      catalog.owner = { name: str(o.name)! };
      if (str(o.url)) catalog.owner.url = str(o.url)!;
    }
  }
  for (const raw of Array.isArray(b.packages) ? b.packages : []) {
    if (raw === null || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const name = str(p.name);
    const source = str(p.source);
    if (!name || !source) continue;
    const version = str(p.version);
    const entry: CatalogEntry = {
      name,
      source:
        version && !source.includes('#') && !/^(\.{1,2}\/|\/|~\/)/.test(source)
          ? `${source}#${version}`
          : source,
    };
    if (str(p.description)) entry.description = str(p.description)!;
    if (version) entry.version = version;
    if (str(p.license)) entry.license = str(p.license)!;
    if (str(p.category)) entry.category = str(p.category)!;
    if (Array.isArray(p.tags)) entry.tags = p.tags.map(String);
    if (Array.isArray(p.tools)) entry.tools = p.tools.map(String);
    if (p.nativePlugin === true || p['x-ahub-native-plugin'] === true) entry.nativePlugin = true;
    catalog.entries.push(entry);
  }
  return catalog;
}
