import { AhubError } from './errors.js';
import { t } from './i18n.js';

export const IMPLEMENTATION_DEFAULT_HOST = 'github.com';

export type UrlForm = 'shorthand' | 'https' | 'http' | 'ssh' | 'scp';

/** Référence de dépendance OpenAPM analysée (spec §4.3). */
export interface DepRef {
  kind: 'git' | 'local' | 'registry';
  /** Forme d'URL d'origine, conservée pour construire l'URL de clonage. */
  form?: UrlForm;
  host?: string;
  port?: number;
  owner?: string;
  repo?: string;
  /** Identité canonique du dépôt : `hôte/propriétaire/dépôt`. */
  repoUrl?: string;
  virtualPath?: string;
  ref?: string;
  localPath?: string;
  alias?: string;
  skills?: string[];
  targets?: string[];
  /** Entrée `id:` (registre REST) : conservée, non résolue en v0.1. */
  registryId?: string;
}

const HOST_RE = /^[A-Za-z0-9.-]+$/;
const OWNER_RE = /^[A-Za-z0-9_-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const LOCAL_PREFIXES = ['./', '../', '/', '~/', '.\\', '..\\', '~\\'];
const LOCAL_TAIL_RE = /^[A-Za-z0-9/\\:._~-]+$/;
const ALIAS_RE = /^[A-Za-z0-9._-]+$/;

export function isLocalPathString(s: string): boolean {
  return LOCAL_PREFIXES.some((p) => s.startsWith(p));
}

function bad(entry: string, why: string): never {
  throw new AhubError('MANIFEST_INVALID', t('invalid dependency "{0}": {1}', [entry, why]), { entry });
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
}

function finishGit(
  entry: string,
  form: UrlForm,
  host: string,
  port: number | undefined,
  segments: string[],
  ref: string | undefined,
): DepRef {
  if (!HOST_RE.test(host)) bad(entry, t('invalid host "{0}"', [host]));
  if (segments.length < 2) bad(entry, t('at least owner/repo is required'));
  const owner = segments[0]!;
  const repo = stripGitSuffix(segments[1]!);
  if (!OWNER_RE.test(owner)) bad(entry, t('invalid owner "{0}"', [owner]));
  if (!repo || !REPO_RE.test(repo)) bad(entry, t('invalid repository "{0}"', [segments[1]]));
  const virtual = segments.slice(2);
  for (const seg of virtual) {
    if (!SEGMENT_RE.test(seg) || seg === '.' || seg === '..')
      bad(entry, t('invalid path segment "{0}"', [seg]));
  }
  if (ref !== undefined && (ref.length === 0 || /[^\x21-\x7e]/.test(ref)))
    bad(entry, t('invalid reference (#ref)'));
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    bad(entry, t('port outside 1-65535'));
  const h = host.toLowerCase();
  const out: DepRef = { kind: 'git', form, host: h, owner, repo, repoUrl: `${h}/${owner}/${repo}` };
  if (port !== undefined) out.port = port;
  if (virtual.length > 0) out.virtualPath = virtual.join('/');
  if (ref !== undefined) out.ref = ref;
  return out;
}

/** Analyse la forme chaîne d'une dépendance (ABNF de la spec §4.3.1, req-mf-007). */
export function parseDepString(input: string, defaultHost = IMPLEMENTATION_DEFAULT_HOST): DepRef {
  const entry = input.trim();
  if (!entry) bad(input, t('empty string'));

  if (isLocalPathString(entry)) {
    if (!LOCAL_TAIL_RE.test(entry)) bad(entry, t('characters not allowed in a local path'));
    return { kind: 'local', localPath: entry.replace(/\\/g, '/') };
  }

  const hashAt = entry.indexOf('#');
  const main = hashAt === -1 ? entry : entry.slice(0, hashAt);
  const ref = hashAt === -1 ? undefined : entry.slice(hashAt + 1);

  const urlMatch = /^(https:\/\/|http:\/\/|ssh:\/\/git@)([^/:]+)(?::(\d+))?\/(.+)$/.exec(main);
  if (urlMatch) {
    const scheme = urlMatch[1]!;
    const form: UrlForm = scheme === 'https://' ? 'https' : scheme === 'http://' ? 'http' : 'ssh';
    const port = urlMatch[3] ? Number(urlMatch[3]) : undefined;
    return finishGit(entry, form, urlMatch[2]!, port, urlMatch[4]!.split('/'), ref);
  }
  const scpMatch = /^git@([^/:]+)[:/](.+)$/.exec(main);
  if (scpMatch) {
    return finishGit(entry, 'scp', scpMatch[1]!, undefined, scpMatch[2]!.split('/'), ref);
  }
  if (main.includes('://') || main.includes('@')) bad(entry, t('unrecognised URL form'));

  const segments = main.split('/');
  if (segments.some((s) => s.length === 0)) bad(entry, t('empty segment'));
  // Raccourci avec hôte : le premier segment est un nom de domaine (contient un point).
  if (segments.length >= 3 && segments[0]!.includes('.') && HOST_RE.test(segments[0]!)) {
    return finishGit(entry, 'shorthand', segments[0]!, undefined, segments.slice(1), ref);
  }
  return finishGit(entry, 'shorthand', defaultHost, undefined, segments, ref);
}

function asStringList(value: unknown, entryLabel: string, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((v) => typeof v === 'string' && v.length > 0)) {
    bad(entryLabel, t('"{0}" must be a string or a list of strings', [field]));
  }
  return list as string[];
}

/** Analyse une entrée `dependencies.apm[]`, forme chaîne ou forme objet (spec §4.3.2). */
export function parseDepEntry(entry: unknown, defaultHost = IMPLEMENTATION_DEFAULT_HOST): DepRef {
  if (typeof entry === 'string') return parseDepString(entry, defaultHost);
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    bad(JSON.stringify(entry), t('a string or an object is expected'));
  }
  const o = entry as Record<string, unknown>;
  const label = JSON.stringify(o);
  if (o.git !== undefined && o.id !== undefined)
    bad(label, t('"git" and "id" are mutually exclusive (req-mf-011)'));

  let ref: DepRef;
  if (typeof o.id === 'string') {
    ref = { kind: 'registry', registryId: o.id };
  } else if (typeof o.git === 'string') {
    if (o.git === 'parent')
      bad(label, t('"git: parent" is only valid in a transitive package (not supported in v0.1)'));
    ref = parseDepString(o.git, defaultHost);
    if (ref.kind !== 'git') bad(label, t('"git" must point to a repository'));
    if (typeof o.path === 'string' && o.path) {
      const p = o.path.replace(/^\/+|\/+$/g, '');
      for (const seg of p.split('/')) {
        if (!SEGMENT_RE.test(seg) || seg === '..' || seg === '.')
          bad(label, t('invalid path "{0}"', [o.path]));
      }
      ref.virtualPath = ref.virtualPath ? `${ref.virtualPath}/${p}` : p;
    }
    if (o.ref !== undefined) {
      if (typeof o.ref !== 'string' || !o.ref) bad(label, t('"ref" must be a non-empty string'));
      ref.ref = o.ref;
    }
  } else if (typeof o.path === 'string') {
    if (!isLocalPathString(o.path)) bad(label, t('"path" alone must be a local path (./, ../, /, ~/)'));
    ref = parseDepString(o.path, defaultHost);
  } else {
    bad(label, t('"git", "id" or "path" is missing'));
  }

  if (o.alias !== undefined) {
    const alias = typeof o.alias === 'string' ? o.alias.trim() : '';
    if (!alias || !ALIAS_RE.test(alias) || alias === '.' || alias === '..') {
      bad(label, t('invalid alias "{0}" (req-mf-025)', [String(o.alias)]));
    }
    ref.alias = alias;
  }
  const skills = asStringList(o.skills, label, 'skills');
  if (skills) ref.skills = skills;
  const targets = asStringList(o.targets, label, 'targets');
  if (targets) ref.targets = targets;
  return ref;
}

/** Clé d'identité d'une dépendance : dépôt + sous-chemin, ou chemin local. */
export function depIdentity(ref: DepRef): string {
  if (ref.kind === 'local') return `local:${ref.localPath}`;
  if (ref.kind === 'registry') return `registry:${ref.registryId}`;
  return ref.virtualPath ? `${ref.repoUrl}/${ref.virtualPath}` : ref.repoUrl!;
}

/**
 * Forme canonique d'écriture (req-mf-009) : seul l'hôte par défaut est retiré ;
 * les autres hôtes gardent leur nom complet.
 */
export function canonicalDepString(ref: DepRef, defaultHost = IMPLEMENTATION_DEFAULT_HOST): string {
  if (ref.kind === 'local') return ref.localPath!;
  if (ref.kind === 'registry') return ref.registryId!;
  const simple =
    (ref.form === 'shorthand' || ref.form === 'https' || ref.form === 'scp') && ref.port === undefined;
  let base: string;
  if (simple) {
    base =
      ref.host === defaultHost.toLowerCase()
        ? `${ref.owner}/${ref.repo}`
        : `${ref.host}/${ref.owner}/${ref.repo}`;
  } else {
    const scheme = ref.form === 'http' ? 'http://' : ref.form === 'ssh' ? 'ssh://git@' : 'https://';
    base = `${scheme}${ref.host}${ref.port ? `:${ref.port}` : ''}/${ref.owner}/${ref.repo}`;
  }
  if (ref.virtualPath) base += `/${ref.virtualPath}`;
  if (ref.ref) base += `#${ref.ref}`;
  return base;
}

/** URL de clonage git correspondant à la référence. */
export function cloneUrl(ref: DepRef): string {
  if (ref.kind !== 'git') throw new AhubError('INTERNAL', t('cloneUrl: not a git reference'));
  const hostPort = `${ref.host}${ref.port ? `:${ref.port}` : ''}`;
  switch (ref.form) {
    case 'http':
      return `http://${hostPort}/${ref.owner}/${ref.repo}.git`;
    case 'ssh':
      return `ssh://git@${hostPort}/${ref.owner}/${ref.repo}.git`;
    case 'scp':
      return `git@${ref.host}:${ref.owner}/${ref.repo}.git`;
    default:
      return `https://${hostPort}/${ref.owner}/${ref.repo}.git`;
  }
}

/** Un chemin virtuel désigne un fichier seulement d'après son extension (req-mf-008). */
export function isVirtualFile(virtualPath: string): boolean {
  return /\.(prompt|instructions|agent)\.md$/.test(virtualPath);
}

export type CliPackageArg =
  { type: 'dep'; dep: string } | { type: 'catalog'; name: string; registry?: string };

/**
 * Interprète l'argument de `ahub add`.
 * Écart de confort documenté : `owner/repo@tag` est accepté et réécrit en
 * `owner/repo#tag` ; `nom` ou `nom@registre` (sans `/`) désigne un paquet de catalogue.
 */
export function parseCliPackageArg(arg: string): CliPackageArg {
  const a = arg.trim();
  if (!a) throw new AhubError('USAGE', t('empty package name'));
  if (isLocalPathString(a)) return { type: 'dep', dep: a };
  if (!a.includes('/')) {
    const at = a.indexOf('@');
    if (at === -1) return { type: 'catalog', name: a };
    const name = a.slice(0, at);
    const registry = a.slice(at + 1);
    if (!name || !registry) throw new AhubError('USAGE', t('invalid catalog reference "{0}"', [a]));
    return { type: 'catalog', name, registry };
  }
  if (!a.includes('#')) {
    const lastSlash = a.lastIndexOf('/');
    const at = a.lastIndexOf('@');
    if (at > lastSlash) return { type: 'dep', dep: `${a.slice(0, at)}#${a.slice(at + 1)}` };
  }
  return { type: 'dep', dep: a };
}
