import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RegistryConfig } from './config.js';
import { canonicalDepString, parseDepString } from './depref.js';
import { AhubError, type Diagnostic } from './errors.js';
import { ensureMirror, type GitOptions, materialize, revParse } from './git.js';
import { MANIFEST_FILE, ManifestFile } from './manifest.js';
import {
  type Catalog,
  type CatalogEntry,
  catalogFromManifestBlock,
  MARKETPLACE_SEARCH_ORDER,
  parseMarketplace,
} from './marketplace.js';
import { repoLocation, resolveLocalPath } from './resolver.js';

export interface RegistryContext {
  git: GitOptions;
  home: string;
  cwd: string;
  fetch?: typeof fetch;
}

export interface RegistryEntry extends CatalogEntry {
  registry: string;
}

/** Lit le catalogue d'un dossier : `apm.yml` avec bloc `marketplace:` d'abord, sinon un marketplace.json natif. */
async function catalogFromDir(
  dir: string,
  name: string,
  ctx: { baseRepo?: string; baseRef?: string; baseDir?: string },
): Promise<{ catalog: Catalog; diagnostics: Diagnostic[] }> {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    const manifest = ManifestFile.parse(
      await readFile(manifestPath, 'utf8'),
      `${name}/${MANIFEST_FILE}`,
    ).manifest;
    if (manifest.marketplace !== undefined) {
      const catalog = catalogFromManifestBlock(manifest.marketplace, manifest.name);
      // Les sources relatives du bloc sont rapportées au dépôt ou au dossier du registre.
      for (const e of catalog.entries) {
        if (/^\.{1,2}\//.test(e.source)) {
          const rel = e.source.replace(/^\.\//, '');
          if (ctx.baseDir) e.source = `${ctx.baseDir.replace(/\/+$/, '')}/${rel}`;
          else if (ctx.baseRepo) e.source = `${ctx.baseRepo}/${rel}${ctx.baseRef ? `#${ctx.baseRef}` : ''}`;
        }
      }
      return { catalog, diagnostics: [] };
    }
  }
  for (const rel of MARKETPLACE_SEARCH_ORDER) {
    const file = path.join(dir, rel);
    if (!existsSync(file)) continue;
    let json: unknown;
    try {
      json = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      throw new AhubError('REGISTRY_FAILED', `registre « ${name} » : ${rel} n’est pas un JSON valide`);
    }
    return parseMarketplace(json, ctx);
  }
  throw new AhubError(
    'REGISTRY_FAILED',
    `registre « ${name} » : aucun catalogue trouvé (apm.yml avec « marketplace: » ou marketplace.json)`,
  );
}

/** Charge le catalogue complet d'un registre. */
export async function loadCatalog(
  reg: RegistryConfig,
  ctx: RegistryContext,
): Promise<{ catalog: Catalog; diagnostics: Diagnostic[] }> {
  if (reg.kind === 'path') {
    const dir = resolveLocalPath(reg.url, ctx.cwd, ctx.home);
    if (!existsSync(dir))
      throw new AhubError('REGISTRY_FAILED', `registre « ${reg.name} » : dossier introuvable (${reg.url})`);
    return catalogFromDir(dir, reg.name, { baseDir: dir });
  }
  if (reg.kind === 'git') {
    const ref = parseDepString(reg.url);
    if (ref.kind !== 'git')
      throw new AhubError('REGISTRY_FAILED', `registre « ${reg.name} » : URL git invalide`);
    const gitDir = await ensureMirror(repoLocation(ref, ctx.git), ctx.git, true);
    const commit = await revParse(gitDir, ref.ref ?? 'HEAD');
    if (!commit) throw new AhubError('REGISTRY_FAILED', `registre « ${reg.name} » : référence introuvable`);
    const work = await mkdtemp(path.join(os.tmpdir(), 'ahub-registry-'));
    try {
      await materialize(gitDir, commit, work);
      const dir = ref.virtualPath ? path.join(work, ...ref.virtualPath.split('/')) : work;
      const { ref: _ref, virtualPath: _vp, ...repoOnly } = ref;
      const baseRepo = canonicalDepString(repoOnly) + (ref.virtualPath ? `/${ref.virtualPath}` : '');
      return await catalogFromDir(dir, reg.name, { baseRepo, baseRef: ref.ref ?? commit });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  // Serveur Agenteca : API REST décrite par l'OpenAPI de agenteca-server.
  const doFetch = ctx.fetch ?? fetch;
  const entries: CatalogEntry[] = [];
  const base = reg.url.replace(/\/+$/, '');
  for (let page = 1; page <= 50; page++) {
    let res: Response;
    try {
      res = await doFetch(`${base}/api/v1/packages?page=${page}&pageSize=100`, {
        headers: { accept: 'application/json' },
      });
    } catch (e) {
      throw new AhubError(
        'REGISTRY_FAILED',
        `registre « ${reg.name} » injoignable : ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok)
      throw new AhubError('REGISTRY_FAILED', `registre « ${reg.name} » : réponse HTTP ${res.status}`);
    const body = (await res.json()) as { items?: Array<Record<string, unknown>>; total?: number };
    for (const it of body.items ?? []) {
      if (typeof it.name !== 'string' || typeof it.source !== 'string') continue;
      const e: CatalogEntry = { name: it.name, source: it.source };
      if (typeof it.description === 'string') e.description = it.description;
      if (typeof it.latestVersion === 'string') e.version = it.latestVersion;
      if (typeof it.license === 'string') e.license = it.license;
      if (Array.isArray(it.tools)) e.tools = it.tools.map(String);
      if (Array.isArray(it.tags)) e.tags = it.tags.map(String);
      if (it.nativePlugin === true) e.nativePlugin = true;
      entries.push(e);
    }
    if (!body.items || body.items.length < 100) break;
  }
  return { catalog: { name: reg.name, entries }, diagnostics: [] };
}

export function matchesQuery(entry: CatalogEntry, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [entry.name, entry.description ?? '', ...(entry.tags ?? []), entry.category ?? '']
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export interface SearchResult {
  entries: RegistryEntry[];
  /** Registres en échec : la recherche continue sur les autres, l'échec est rapporté. */
  failures: Array<{ registry: string; message: string }>;
}

/** Cherche dans tous les registres configurés (ou un seul). */
export async function searchRegistries(
  registries: RegistryConfig[],
  query: string,
  ctx: RegistryContext,
  opts: { registry?: string; tool?: string } = {},
): Promise<SearchResult> {
  const selected = opts.registry ? registries.filter((r) => r.name === opts.registry) : registries;
  if (opts.registry && selected.length === 0)
    throw new AhubError('NOT_FOUND', `registre « ${opts.registry} » inconnu`);
  const result: SearchResult = { entries: [], failures: [] };
  for (const reg of selected) {
    try {
      const { catalog } = await loadCatalog(reg, ctx);
      for (const e of catalog.entries) {
        if (!matchesQuery(e, query)) continue;
        if (opts.tool && e.tools && e.tools.length > 0 && !e.tools.includes(opts.tool)) continue;
        result.entries.push({ ...e, registry: reg.name });
      }
    } catch (e) {
      result.failures.push({ registry: reg.name, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
