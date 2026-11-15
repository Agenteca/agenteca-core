import { AhubError } from './errors.js';
import { normalizeEnvelope } from './hash.js';
import { parseYamlSafe, stringifyYaml } from './yaml.js';
import { t } from './i18n.js';

export const LOCK_FILE = 'apm.lock.yaml';
export const LEGACY_LOCK_FILE = 'apm.lock';
const KNOWN_VERSIONS = ['1', '2'];

/** Entrée fusionnée dans un fichier de configuration partagé (hooks, MCP). */
export interface MergedEntryRecord {
  /**
   * `key` : valeur posée à un chemin de clés ; `append` : élément ajouté à une liste ;
   * `block` : table TOML dans un bloc délimité ; `ensure` : valeur posée seulement si
   * absente et jamais retirée (clé partagée, par exemple `version`).
   */
  type: 'key' | 'append' | 'block' | 'ensure';
  keyPath: string[];
  value: unknown;
}

/** Registre de propriété d'un fichier de configuration partagé. */
export interface MergedFileRecord {
  path: string;
  format: 'json' | 'toml';
  kind: 'mcp' | 'hooks';
  target: string;
  /** Le fichier a été créé par Agenteca : il est supprimé s'il redevient vide. */
  created?: boolean;
  entries: MergedEntryRecord[];
}

/** Extension fournisseur `x-ahub` d'une entrée (req-ext-001). */
export interface AhubEntryExtension {
  targets?: string[];
  merged?: MergedFileRecord[];
}

/** Entrée de dépendance du lockfile (spec §5.2). Les champs inconnus sont conservés. */
export interface LockEntry {
  repo_url?: string;
  alias?: string;
  host?: string;
  port?: number;
  resolved_ref?: string;
  resolved_commit?: string;
  tree_sha256?: string;
  version?: string;
  name?: string;
  virtual_path?: string;
  is_virtual?: boolean;
  depth?: number;
  resolved_by?: string;
  package_type?: string;
  skill_subset?: string[];
  deployed_files?: string[];
  deployed_file_hashes?: Record<string, string>;
  source?: 'local' | 'registry';
  local_path?: string;
  content_hash?: string;
  is_dev?: boolean;
  constraint?: string;
  resolved_tag?: string;
  resolved_at?: string;
  declared_license?: string;
  'x-ahub'?: AhubEntryExtension;
  [key: string]: unknown;
}

export interface Lockfile {
  lockfile_version: '1' | '2';
  generated_at?: string;
  apm_version?: string;
  dependencies: LockEntry[];
  mcp_servers?: string[];
  mcp_configs?: Record<string, unknown>;
  /** Champ de l'outil apm : cible → serveurs MCP écrits pour elle. Il y lit la propriété des entrées. */
  mcp_target_servers?: Record<string, string[]>;
  local_deployed_files?: string[];
  local_deployed_file_hashes?: Record<string, string>;
  [key: string]: unknown;
}

const TOP_ORDER = [
  'lockfile_version',
  'generated_at',
  'apm_version',
  'dependencies',
  'mcp_servers',
  'mcp_configs',
  'mcp_target_servers',
  'local_deployed_files',
  'local_deployed_file_hashes',
];

const ENTRY_ORDER = [
  'repo_url',
  'materialization_repo_url',
  'alias',
  'host',
  'port',
  'registry_prefix',
  'name',
  'version',
  'resolved_ref',
  'resolved_commit',
  'tree_sha256',
  'constraint',
  'resolved_tag',
  'resolved_at',
  'virtual_path',
  'is_virtual',
  'source',
  'local_path',
  'content_hash',
  'resolved_url',
  'resolved_hash',
  'depth',
  'resolved_by',
  'is_dev',
  'package_type',
  'declared_license',
  'skill_subset',
  'deployed_files',
  'deployed_file_hashes',
  'extensions',
];

const HASH_FIELDS = ['tree_sha256', 'content_hash', 'resolved_hash'];

/** Clé d'identité d'une entrée : dépôt + sous-chemin, ou chemin local. */
export function entryIdentity(entry: LockEntry): string {
  if (entry.source === 'local') return `local:${entry.local_path}`;
  const repo = canonicalRepoUrl(entry);
  return entry.virtual_path ? `${repo}/${entry.virtual_path}` : repo;
}

/**
 * Identité `hôte/propriétaire/dépôt` d'une entrée. L'outil apm écrit l'hôte à part
 * (`repo_url: propriétaire/dépôt`, `host: github.com`) : les deux formes sont lues.
 */
export function canonicalRepoUrl(entry: LockEntry): string {
  const repo = String(entry.repo_url);
  const first = repo.split('/')[0] ?? '';
  if (first.includes('.') || first === '_local') return repo;
  return `${entry.host ?? 'github.com'}/${repo}`;
}

export function emptyLockfile(): Lockfile {
  return { lockfile_version: '1', dependencies: [] };
}

function invalid(file: string, message: string): never {
  throw new AhubError('LOCK_INVALID', t('{0}: {1}', [file, message]), { file });
}

export function parseLockfile(text: string, file = LOCK_FILE): Lockfile {
  const data = parseYamlSafe(text, file, 'LOCK_INVALID');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    invalid(file, t('the document must be a YAML mapping (req-lk-001)'));
  }
  const lock = data as Lockfile;
  const version = String(lock.lockfile_version ?? '');
  if (!KNOWN_VERSIONS.includes(version)) {
    // req-lk-004 : refuser, en proposant les deux issues.
    invalid(
      file,
      t(
        'lockfile version "{0}" is not recognised (supported versions: {1}). Update ahub, or regenerate the lockfile from the manifest (delete it, then run "ahub install").',
        [version, KNOWN_VERSIONS.join(', ')],
      ),
    );
  }
  lock.lockfile_version = version as '1' | '2';
  if (!Array.isArray(lock.dependencies)) invalid(file, t('"dependencies" must be a list (req-lk-001)'));
  for (const entry of lock.dependencies) {
    if (entry === null || typeof entry !== 'object') invalid(file, t('invalid dependency entry'));
    if (entry.resolved_commit !== undefined && !/^[0-9a-f]{40}$/.test(String(entry.resolved_commit))) {
      invalid(file, t('invalid "resolved_commit" for {0}', [entryIdentity(entry)]));
    }
    for (const f of HASH_FIELDS) {
      if (typeof entry[f] === 'string') entry[f] = normalizeEnvelope(entry[f] as string);
    }
    if (entry.deployed_file_hashes) {
      for (const [p, h] of Object.entries(entry.deployed_file_hashes)) {
        entry.deployed_file_hashes[p] = normalizeEnvelope(String(h));
      }
    }
  }
  return lock;
}

function ordered(obj: Record<string, unknown>, order: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const isUnset = (v: unknown): boolean =>
    v === undefined ||
    v === null ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);
  for (const k of order) if (!isUnset(obj[k])) out[k] = obj[k];
  // Champs inconnus et extensions `x-*` conservés (req-lk-011, req-lk-014), dans un ordre stable.
  for (const k of Object.keys(obj).sort()) {
    if (!(k in out) && !order.includes(k) && !isUnset(obj[k])) out[k] = obj[k];
  }
  return out;
}

/**
 * Sérialise le lockfile : champs non définis omis, entrées triées par
 * (`repo_url`, `virtual_path`), version jamais rétrogradée (req-lk-002).
 */
export function serializeLockfile(lock: Lockfile, previous?: Lockfile): string {
  const version =
    previous?.lockfile_version === '2' || lock.dependencies.some((d) => d.source === 'registry')
      ? '2'
      : lock.lockfile_version;
  const deps = [...lock.dependencies]
    .sort((a, b) => {
      const ka = `${a.repo_url ?? `~${a.local_path ?? ''}`}\u0000${a.virtual_path ?? ''}`;
      const kb = `${b.repo_url ?? `~${b.local_path ?? ''}`}\u0000${b.virtual_path ?? ''}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .map((d) => {
      const e: Record<string, unknown> = { ...d };
      if (Array.isArray(e.deployed_files)) e.deployed_files = [...(e.deployed_files as string[])].sort();
      if (e.deployed_file_hashes) {
        const sorted: Record<string, string> = {};
        for (const k of Object.keys(e.deployed_file_hashes as object).sort()) {
          sorted[k] = (e.deployed_file_hashes as Record<string, string>)[k]!;
        }
        e.deployed_file_hashes = sorted;
      }
      return ordered(e, ENTRY_ORDER);
    });
  const top: Record<string, unknown> = { ...lock, lockfile_version: version, dependencies: deps };
  const out = ordered(top, TOP_ORDER);
  // `dependencies` est requis même vide (req-lk-001).
  if (!('dependencies' in out)) {
    return stringifyYaml({ lockfile_version: version, dependencies: [], ...out });
  }
  return stringifyYaml(out);
}
