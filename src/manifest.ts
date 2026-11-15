import { type Document, isMap, isScalar, isSeq, YAMLMap, YAMLSeq } from 'yaml';
import {
  canonicalDepString,
  type DepRef,
  depIdentity,
  IMPLEMENTATION_DEFAULT_HOST,
  parseDepEntry,
} from './depref.js';
import { AhubError, type Diagnostic } from './errors.js';
import { parseYamlDocument } from './yaml.js';
import { t } from './i18n.js';

export const MANIFEST_FILE = 'apm.yml';

/** Identifiants de cible canoniques d'OpenAPM v0.1 (spec §4.2.1). */
export const CANONICAL_TARGETS = [
  'copilot',
  'claude',
  'cursor',
  'codex',
  'gemini',
  'antigravity',
  'opencode',
  'windsurf',
  'agent-skills',
  'all',
] as const;

/** Cibles pour lesquelles Agenteca fournit un adaptateur. */
export const SUPPORTED_TARGETS = ['claude', 'codex', 'copilot', 'cursor'] as const;
export type Target = (typeof SUPPORTED_TARGETS)[number];

const TARGET_ALIASES: Record<string, string> = { vscode: 'copilot', agents: 'copilot' };
const VENDOR_TARGET_RE = /^x-[a-z][a-z0-9-]*-[a-z][a-z0-9-]*$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export type McpTransport = 'stdio' | 'http' | 'sse' | 'streamable-http';

/** Serveur MCP déclaré dans `dependencies.mcp` (spec §4.3.6). */
export interface McpDependency {
  name: string;
  /** `false` : serveur auto-défini ; chaîne ou absent : serveur de registre MCP. */
  registry?: boolean | string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  tools?: string[];
  version?: string;
}

export interface Manifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  defaultHost: string;
  /** Cibles déclarées, normalisées ; `undefined` si le manifeste n'en déclare pas. */
  targets?: string[];
  apm: DepRef[];
  devApm: DepRef[];
  mcp: McpDependency[];
  devMcp: McpDependency[];
  scripts: Record<string, string>;
  marketplace?: unknown;
  diagnostics: Diagnostic[];
}

function invalid(file: string, message: string): never {
  throw new AhubError('MANIFEST_INVALID', t('{0}: {1}', [file, message]), { file });
}

/** Normalise une liste de cibles (alias → `copilot`), rejette les inconnues (req-mf-005). */
export function normalizeTargets(value: unknown, file: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') invalid(file, t('a target must be a string'));
    for (const token of raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)) {
      const target = TARGET_ALIASES[token] ?? token;
      if (!(CANONICAL_TARGETS as readonly string[]).includes(target) && !VENDOR_TARGET_RE.test(target)) {
        invalid(file, t('unknown target "{0}"', [token]));
      }
      if (!out.includes(target)) out.push(target);
    }
  }
  return out;
}

function parseMcpEntry(entry: unknown, file: string): McpDependency {
  if (typeof entry === 'string') {
    if (!entry.trim()) invalid(file, t('empty MCP entry'));
    return { name: entry.trim() };
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
    invalid(file, t('invalid MCP entry'));
  const o = entry as Record<string, unknown>;
  if (typeof o.name !== 'string' || !o.name) invalid(file, t('an MCP server must have a "name"'));
  const dep: McpDependency = { name: o.name };
  if (o.registry === false || typeof o.registry === 'string') dep.registry = o.registry;
  if (typeof o.transport === 'string') dep.transport = o.transport as McpTransport;
  if (typeof o.command === 'string') dep.command = o.command;
  if (Array.isArray(o.args)) dep.args = o.args.map(String);
  if (o.env && typeof o.env === 'object') dep.env = mapOfStrings(o.env);
  if (typeof o.url === 'string') dep.url = o.url;
  if (o.headers && typeof o.headers === 'object') dep.headers = mapOfStrings(o.headers);
  if (Array.isArray(o.tools)) dep.tools = o.tools.map(String);
  if (typeof o.version === 'string') dep.version = o.version;

  // req-mf-012 : validation des serveurs auto-définis.
  if (dep.registry === false) {
    if (!dep.transport) invalid(file, t('MCP server "{0}": "transport" is missing', [dep.name]));
    if (dep.transport === 'stdio') {
      if (!dep.command) invalid(file, t('MCP server "{0}": "command" is missing (stdio)', [dep.name]));
      if (/\s/.test(dep.command) && o.args === undefined) {
        invalid(file, t('MCP server "{0}": "command" contains spaces without "args"', [dep.name]));
      }
    } else if (['http', 'sse', 'streamable-http'].includes(dep.transport)) {
      if (!dep.url) invalid(file, t('MCP server "{0}": "url" is missing ({1})', [dep.name, dep.transport]));
    } else {
      invalid(file, t('MCP server "{0}": unknown transport "{1}"', [dep.name, String(dep.transport)]));
    }
  }
  return dep;
}

function mapOfStrings(value: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) out[k] = String(v);
  return out;
}

/** Lit un scalaire tel qu'écrit dans le fichier, pour éviter la coercition numérique (`1.0` → `1`). */
function scalarSource(doc: Document, key: string): string | undefined {
  const node = doc.get(key, true);
  if (!isScalar(node)) return undefined;
  if (typeof node.value === 'string') return node.value;
  if (typeof node.source === 'string') return node.source;
  return node.value === null || node.value === undefined ? undefined : String(node.value);
}

function depList(doc: Document, block: string, key: string): unknown[] {
  const deps = doc.getIn([block, key]);
  if (deps === undefined || deps === null) return [];
  if (!isSeq(deps)) invalid(MANIFEST_FILE, t('"{0}.{1}" must be a list', [block, key]));
  return (deps as YAMLSeq).toJSON() as unknown[];
}

/**
 * Manifeste `apm.yml` chargé. Le document YAML d'origine est conservé pour
 * que la réécriture préserve commentaires et clés inconnues (req-mf-006, req-ext-001).
 */
export class ManifestFile {
  private constructor(
    readonly doc: Document,
    readonly manifest: Manifest,
    readonly file: string,
  ) {}

  static parse(text: string, file = MANIFEST_FILE): ManifestFile {
    const doc = parseYamlDocument(text, file, 'MANIFEST_INVALID');
    if (!isMap(doc.contents)) invalid(file, t('the document must be a YAML mapping (req-mf-001)'));
    const diagnostics: Diagnostic[] = [];

    const name = scalarSource(doc, 'name');
    if (!name || !name.trim()) invalid(file, t('field "name" is missing or empty (req-mf-002)'));
    const version = scalarSource(doc, 'version');
    if (version === undefined) invalid(file, t('field "version" is missing (req-mf-003)'));
    if (!SEMVER_RE.test(version)) {
      diagnostics.push({
        code: 'VERSION_NOT_SEMVER',
        message: t('{0}: "{1}" is not a SemVer 2.0.0 version', [file, version]),
      });
    }

    const js = doc.toJS() as Record<string, unknown>;
    if (js.target !== undefined && js.targets !== undefined) {
      invalid(file, t('"target" and "targets" are mutually exclusive (req-tg-008)'));
    }
    const targets = normalizeTargets(js.targets ?? js.target, file);
    const defaultHost =
      typeof js.default_host === 'string' && js.default_host ? js.default_host : IMPLEMENTATION_DEFAULT_HOST;

    const parseDeps = (block: string): DepRef[] =>
      depList(doc, block, 'apm').map((e) => parseDepEntry(e, defaultHost));
    const parseMcp = (block: string): McpDependency[] =>
      depList(doc, block, 'mcp').map((e) => parseMcpEntry(e, file));

    const scripts: Record<string, string> = {};
    if (js.scripts && typeof js.scripts === 'object' && !Array.isArray(js.scripts)) {
      for (const [k, v] of Object.entries(js.scripts)) scripts[k] = String(v);
    }

    const manifest: Manifest = {
      name: name.trim(),
      version,
      defaultHost,
      apm: parseDeps('dependencies'),
      devApm: parseDeps('devDependencies'),
      mcp: parseMcp('dependencies'),
      devMcp: parseMcp('devDependencies'),
      scripts,
      diagnostics,
    };
    if (typeof js.description === 'string') manifest.description = js.description;
    if (typeof js.author === 'string') manifest.author = js.author;
    if (typeof js.license === 'string') manifest.license = js.license;
    if (targets) manifest.targets = targets;
    if (js.marketplace !== undefined) manifest.marketplace = js.marketplace;
    return new ManifestFile(doc, manifest, file);
  }

  /** Crée un manifeste minimal conforme (name + version). */
  static create(init: {
    name: string;
    version?: string;
    description?: string;
    targets?: string[];
  }): ManifestFile {
    const lines = [
      `name: ${JSON.stringify(init.name)}`,
      `version: ${JSON.stringify(init.version ?? '0.1.0')}`,
    ];
    if (init.description) lines.push(`description: ${JSON.stringify(init.description)}`);
    if (init.targets && init.targets.length > 0) {
      lines.push('targets:', ...init.targets.map((t) => `  - ${t}`));
    }
    lines.push('dependencies:', '  apm: []', '');
    return ManifestFile.parse(lines.join('\n'));
  }

  private apmSeq(create: boolean): YAMLSeq | undefined {
    let deps: unknown = this.doc.get('dependencies', true);
    if (!isMap(deps)) {
      if (!create) return undefined;
      deps = new YAMLMap();
      this.doc.set('dependencies', deps);
    }
    const map = deps as YAMLMap;
    let seq: unknown = map.get('apm', true);
    if (!isSeq(seq)) {
      if (!create) return undefined;
      seq = new YAMLSeq();
      map.set('apm', seq);
    }
    const list = seq as YAMLSeq;
    list.flow = false;
    return list;
  }

  /**
   * Ajoute ou remplace une dépendance directe, en forme canonique (req-mf-009).
   * Retourne `true` si une entrée existante de même identité a été remplacée.
   */
  setApmDependency(ref: DepRef): boolean {
    if (ref.kind === 'registry') {
      throw new AhubError('UNSUPPORTED', t('registry dependencies ("id:") are not supported in v0.1'));
    }
    const seq = this.apmSeq(true)!;
    const identity = depIdentity(ref);
    const value = this.serializeDep(ref);
    const index = this.manifest.apm.findIndex((d) => depIdentity(d) === identity);
    if (index >= 0) {
      seq.set(index, this.doc.createNode(value));
      this.manifest.apm[index] = ref;
      return true;
    }
    seq.add(this.doc.createNode(value));
    this.manifest.apm.push(ref);
    return false;
  }

  /** Forme chaîne si possible, forme objet si des options (alias, skills, targets) sont présentes. */
  private serializeDep(ref: DepRef): unknown {
    const canonical = canonicalDepString(ref, this.manifest.defaultHost);
    if (!ref.alias && !ref.skills && !ref.targets) return canonical;
    const { ref: gitRef, ...rest } = ref;
    const out: Record<string, unknown> =
      ref.kind === 'local'
        ? { path: ref.localPath }
        : { git: canonicalDepString({ ...rest }, this.manifest.defaultHost) };
    if (gitRef) out.ref = gitRef;
    if (ref.alias) out.alias = ref.alias;
    if (ref.skills) out.skills = ref.skills;
    if (ref.targets) out.targets = ref.targets;
    return out;
  }

  /** Retire la dépendance directe d'identité donnée. Retourne `false` si elle est absente. */
  removeApmDependency(identity: string): boolean {
    const index = this.manifest.apm.findIndex((d) => depIdentity(d) === identity);
    if (index < 0) return false;
    this.apmSeq(false)?.delete(index);
    this.manifest.apm.splice(index, 1);
    return true;
  }

  /**
   * Retrouve une dépendance directe par identité exacte, par `propriétaire/dépôt`,
   * ou par nom court de dépôt s'il n'est pas ambigu.
   */
  findDependency(query: string): DepRef | undefined {
    const q = query.replace(/#.*$/, '');
    const exact = this.manifest.apm.find((d) => depIdentity(d) === q || d.localPath === q);
    if (exact) return exact;
    const candidates = this.manifest.apm.filter((d) => {
      if (d.kind === 'local') return d.localPath!.replace(/\/+$/, '').split('/').pop() === q;
      if (d.kind !== 'git') return false;
      const short = `${d.owner}/${d.repo}${d.virtualPath ? `/${d.virtualPath}` : ''}`;
      return short === q || d.repo === q || d.alias === q || d.virtualPath?.split('/').pop() === q;
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  toString(): string {
    return this.doc.toString({ lineWidth: 0 });
  }
}
