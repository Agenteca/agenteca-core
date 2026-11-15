import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AhubError, type Diagnostic } from './errors.js';
import { MANIFEST_FILE, type Manifest, ManifestFile, type McpDependency } from './manifest.js';
import { splitFrontmatter } from './yaml.js';
import { t } from './i18n.js';

export type PackageLayout = 'apm_package' | 'skill_bundle' | 'skill_collection' | 'plugin' | 'hook_package';

export interface PkgFile {
  /** Chemin relatif (POSIX) à la racine de la primitive ou du paquet. */
  relPath: string;
  bytes: Buffer;
  executable: boolean;
}

export interface SkillPrimitive {
  kind: 'skill';
  name: string;
  description?: string;
  /** Chemin du dossier du skill dans le paquet. */
  sourceDir: string;
  /** Fichiers du skill, chemins relatifs au dossier du skill. */
  files: PkgFile[];
}

export interface TextPrimitive {
  kind: 'agent' | 'prompt' | 'instruction';
  name: string;
  sourcePath: string;
  frontmatter: Record<string, unknown> | null;
  /** Le frontmatter existe mais n'a pas pu être lu comme dictionnaire. */
  frontmatterError?: string;
  body: string;
  raw: Buffer;
}

/** Groupe de hooks normalisé (forme Claude : filtre optionnel + gestionnaires). */
export interface HookGroup {
  matcher?: string;
  hooks: Array<Record<string, unknown>>;
}

export interface HookPrimitive {
  kind: 'hook';
  name: string;
  sourcePath: string;
  /** Nom d'événement tel qu'écrit par l'auteur → groupes. */
  events: Record<string, HookGroup[]>;
  raw: Buffer;
}

export interface PackageContent {
  layout: PackageLayout;
  name: string;
  version?: string;
  description?: string;
  license?: string;
  manifest?: Manifest;
  skills: SkillPrimitive[];
  agents: TextPrimitive[];
  prompts: TextPrimitive[];
  instructions: TextPrimitive[];
  hooks: HookPrimitive[];
  mcp: McpDependency[];
  /** Tous les fichiers sources pris en compte, pour le scan et l'aperçu. */
  sourceFiles: PkgFile[];
  diagnostics: Diagnostic[];
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 2000;
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function isDir(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Parcourt un dossier sans jamais suivre de lien symbolique. Les liens, les
 * fichiers trop gros et `.git` sont ignorés avec un diagnostic.
 */
async function walk(root: string, rel: string, diagnostics: Diagnostic[], out: PkgFile[]): Promise<void> {
  const abs = rel ? path.join(root, rel) : root;
  const entries = await readdir(abs, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childAbs = path.join(root, childRel);
    const st = await lstat(childAbs);
    if (st.isSymbolicLink()) {
      diagnostics.push({
        code: 'SYMLINK_SKIPPED',
        message: t('symbolic link skipped: {0}', [childRel]),
        path: childRel,
      });
    } else if (st.isDirectory()) {
      await walk(root, childRel, diagnostics, out);
    } else if (st.isFile()) {
      if (st.size > MAX_FILE_BYTES) {
        diagnostics.push({
          code: 'FILE_TOO_LARGE',
          message: t('file skipped (> 5 MB): {0}', [childRel]),
          path: childRel,
        });
        continue;
      }
      if (out.length >= MAX_FILES) {
        throw new AhubError('PACKAGE_INVALID', t('the package has more than {0} files', [MAX_FILES]));
      }
      out.push({ relPath: childRel, bytes: await readFile(childAbs), executable: (st.mode & 0o111) !== 0 });
    }
  }
}

async function listFiles(root: string, diagnostics: Diagnostic[]): Promise<PkgFile[]> {
  const out: PkgFile[] = [];
  if (await isDir(root)) await walk(root, '', diagnostics, out);
  return out;
}

function safeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

async function readSkill(
  dir: string,
  name: string,
  sourceDir: string,
  diagnostics: Diagnostic[],
): Promise<SkillPrimitive | undefined> {
  if (!(await isFile(path.join(dir, 'SKILL.md')))) return undefined;
  if (!safeName(name)) {
    diagnostics.push({
      code: 'SKILL_NAME_INVALID',
      message: t('skill skipped, unsafe folder name: {0}', [name]),
      path: sourceDir,
    });
    return undefined;
  }
  const files = await listFiles(dir, diagnostics);
  const md = files.find((f) => f.relPath === 'SKILL.md')!;
  const { frontmatter, error } = splitFrontmatter(md.bytes.toString('utf8'), `${sourceDir}/SKILL.md`);
  const where = `${sourceDir}/SKILL.md`;
  if (error || !frontmatter) {
    diagnostics.push({
      code: 'SKILL_FRONTMATTER_INVALID',
      message: t('{0}: front matter missing or unreadable{1}', [where, error ? ` (${error})` : '']),
      path: where,
    });
  } else {
    // Contrôles du standard Agent Skills (agentskills.io/specification).
    const fmName = frontmatter.name;
    if (typeof fmName !== 'string' || !SKILL_NAME_RE.test(fmName) || fmName.length > 64) {
      diagnostics.push({
        code: 'SKILL_NAME_INVALID',
        message: t('{0}: "name" must be 1 to 64 characters: a-z, 0-9, hyphens', [where]),
        path: where,
      });
    } else if (fmName !== name) {
      diagnostics.push({
        code: 'SKILL_NAME_MISMATCH',
        message: t('{0}: "name" ({1}) differs from the folder ({2})', [where, fmName, name]),
        path: where,
      });
    }
    const desc = frontmatter.description;
    if (typeof desc !== 'string' || desc.length === 0 || desc.length > 1024) {
      diagnostics.push({
        code: 'SKILL_DESCRIPTION_INVALID',
        message: t('{0}: "description" must be 1 to 1024 characters', [where]),
        path: where,
      });
    }
  }
  const skill: SkillPrimitive = { kind: 'skill', name, sourceDir, files };
  if (typeof frontmatter?.description === 'string') skill.description = frontmatter.description;
  return skill;
}

async function readSkillsDir(
  root: string,
  relDir: string,
  diagnostics: Diagnostic[],
): Promise<SkillPrimitive[]> {
  const abs = path.join(root, relDir);
  if (!(await isDir(abs))) return [];
  const out: SkillPrimitive[] = [];
  const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skill = await readSkill(path.join(abs, e.name), e.name, `${relDir}/${e.name}`, diagnostics);
    if (skill) out.push(skill);
  }
  return out;
}

async function readTextPrimitives(
  root: string,
  relDir: string,
  kind: TextPrimitive['kind'],
  suffix: string,
  diagnostics: Diagnostic[],
): Promise<TextPrimitive[]> {
  const abs = path.join(root, relDir);
  if (!(await isDir(abs))) return [];
  const out: TextPrimitive[] = [];
  const files = (await readdir(abs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith(suffix)) continue;
    const name = f.name.slice(0, -suffix.length);
    const sourcePath = `${relDir}/${f.name}`;
    if (!safeName(name)) {
      diagnostics.push({
        code: 'NAME_INVALID',
        message: t('file skipped, unsafe name: {0}', [sourcePath]),
        path: sourcePath,
      });
      continue;
    }
    const st = await lstat(path.join(abs, f.name));
    if (st.size > MAX_FILE_BYTES) {
      diagnostics.push({
        code: 'FILE_TOO_LARGE',
        message: t('file skipped (> 5 MB): {0}', [sourcePath]),
        path: sourcePath,
      });
      continue;
    }
    const raw = await readFile(path.join(abs, f.name));
    const { frontmatter, body, error } = splitFrontmatter(raw.toString('utf8'), sourcePath);
    const prim: TextPrimitive = { kind, name, sourcePath, frontmatter, body, raw };
    if (error) {
      prim.frontmatterError = error;
      diagnostics.push({
        code: 'FRONTMATTER_INVALID',
        message: t('{0}: unreadable front matter ({1})', [sourcePath, error]),
        path: sourcePath,
      });
    }
    out.push(prim);
  }
  return out;
}

/** Normalise un fichier de hooks : forme `{"hooks": {...}}` ou forme « nue » par événement. */
export function normalizeHookDocument(json: unknown): Record<string, HookGroup[]> | undefined {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return undefined;
  let events = json as Record<string, unknown>;
  if ('hooks' in events) {
    const inner = events.hooks;
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return undefined;
    events = inner as Record<string, unknown>;
  }
  const out: Record<string, HookGroup[]> = {};
  for (const [event, value] of Object.entries(events)) {
    if (event === 'version' || !Array.isArray(value)) continue;
    const groups: HookGroup[] = [];
    for (const item of value) {
      if (item === null || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      if (Array.isArray(o.hooks)) {
        // Forme Claude : { matcher?, hooks: [gestionnaires] }
        const g: HookGroup = {
          hooks: o.hooks.filter((h) => h && typeof h === 'object') as Array<Record<string, unknown>>,
        };
        if (typeof o.matcher === 'string') g.matcher = o.matcher;
        groups.push(g);
      } else {
        // Forme Copilot : le gestionnaire est directement dans la liste.
        const handler: Record<string, unknown> = { ...o };
        if (handler.command === undefined && typeof handler.bash === 'string') handler.command = handler.bash;
        if (handler.timeout === undefined && typeof handler.timeoutSec === 'number')
          handler.timeout = handler.timeoutSec;
        if (handler.type === undefined) handler.type = 'command';
        const g: HookGroup = { hooks: [handler] };
        if (typeof o.matcher === 'string') {
          g.matcher = o.matcher;
          delete handler.matcher;
        }
        groups.push(g);
      }
    }
    if (groups.length > 0) out[event] = groups;
  }
  return out;
}

async function readHooks(
  root: string,
  relDirs: string[],
  diagnostics: Diagnostic[],
  fileNames?: string[],
): Promise<HookPrimitive[]> {
  const out: HookPrimitive[] = [];
  for (const relDir of relDirs) {
    const abs = path.join(root, relDir);
    if (!(await isDir(abs))) continue;
    const files = (await readdir(abs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      if (fileNames && !fileNames.includes(f.name)) continue;
      const sourcePath = `${relDir}/${f.name}`;
      const name = f.name.slice(0, -5);
      if (!safeName(name)) continue;
      const raw = await readFile(path.join(abs, f.name));
      let json: unknown;
      try {
        json = JSON.parse(raw.toString('utf8'));
      } catch {
        diagnostics.push({
          code: 'HOOK_JSON_INVALID',
          message: t('{0}: invalid JSON, hooks skipped', [sourcePath]),
          path: sourcePath,
        });
        continue;
      }
      const events = normalizeHookDocument(json);
      if (!events) {
        diagnostics.push({
          code: 'HOOK_JSON_INVALID',
          message: t('{0}: unrecognised hook structure', [sourcePath]),
          path: sourcePath,
        });
        continue;
      }
      if (Object.keys(events).length === 0) {
        diagnostics.push({
          code: 'HOOK_EMPTY',
          message: t('{0}: no hook declared', [sourcePath]),
          path: sourcePath,
        });
        continue;
      }
      out.push({ kind: 'hook', name, sourcePath, events, raw });
    }
  }
  return out;
}

/** Convertit un bloc `mcpServers` de plugin (format Claude) en dépendances MCP. */
function mcpFromPluginConfig(json: unknown): McpDependency[] {
  if (json === null || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;
  const servers = (root.mcpServers ?? root) as Record<string, unknown>;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const out: McpDependency[] = [];
  for (const [name, value] of Object.entries(servers)) {
    if (value === null || typeof value !== 'object') continue;
    const s = value as Record<string, unknown>;
    const dep: McpDependency = { name, registry: false };
    if (typeof s.command === 'string') {
      dep.transport = 'stdio';
      dep.command = s.command;
      dep.args = Array.isArray(s.args) ? s.args.map(String) : [];
      if (s.env && typeof s.env === 'object')
        dep.env = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)]));
    } else if (typeof s.url === 'string') {
      dep.transport = s.type === 'sse' ? 'sse' : 'http';
      dep.url = s.url;
      if (s.headers && typeof s.headers === 'object') {
        dep.headers = Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, String(v)]));
      }
    } else {
      continue;
    }
    out.push(dep);
  }
  return out;
}

async function readJson(file: string): Promise<unknown | undefined> {
  if (!(await isFile(file))) return undefined;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function dedupeByName<T extends { name: string }>(items: T[], kind: string, diagnostics: Diagnostic[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    if (seen.has(item.name)) {
      diagnostics.push({
        code: 'DUPLICATE_PRIMITIVE',
        message: t('{0} "{1}" is defined more than once; first definition kept', [kind, item.name]),
      });
    } else {
      seen.set(item.name, item);
    }
  }
  return [...seen.values()];
}

/**
 * Découvre le contenu d'un paquet matérialisé sur disque. La disposition sur
 * disque fait foi, pas le champ `type` du manifeste (spec §8.1).
 */
export async function readPackage(dir: string, fallbackName: string): Promise<PackageContent> {
  if (!(await isDir(dir))) {
    throw new AhubError('PACKAGE_INVALID', t('package "{0}" is not a folder', [fallbackName]));
  }
  const diagnostics: Diagnostic[] = [];
  let manifest: Manifest | undefined;
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (existsSync(manifestPath) && (await isFile(manifestPath))) {
    manifest = ManifestFile.parse(
      await readFile(manifestPath, 'utf8'),
      `${fallbackName}/${MANIFEST_FILE}`,
    ).manifest;
    diagnostics.push(...manifest.diagnostics);
  }

  const hasApmDir = await isDir(path.join(dir, '.apm'));
  const hasRootSkill = await isFile(path.join(dir, 'SKILL.md'));
  const claudePlugin = await readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
  const rootPlugin = await readJson(path.join(dir, 'plugin.json'));
  const pluginJson = (claudePlugin ?? rootPlugin) as Record<string, unknown> | undefined;
  const isPlugin = pluginJson !== undefined || (await isDir(path.join(dir, '.claude-plugin')));
  const hasSkillsDir = await isDir(path.join(dir, 'skills'));

  const content: PackageContent = {
    layout: 'apm_package',
    name: manifest?.name ?? fallbackName,
    skills: [],
    agents: [],
    prompts: [],
    instructions: [],
    hooks: [],
    mcp: [],
    sourceFiles: [],
    diagnostics,
  };
  if (manifest) content.manifest = manifest;
  if (manifest?.version) content.version = manifest.version;
  if (manifest?.description) content.description = manifest.description;
  if (manifest?.license) content.license = manifest.license;

  if (manifest || hasApmDir) {
    // Paquet APM : un `apm.yml` éligible prime sur la disposition plugin.
    content.layout = 'apm_package';
    content.skills.push(...(await readSkillsDir(dir, '.apm/skills', diagnostics)));
    content.agents.push(...(await readTextPrimitives(dir, '.apm/agents', 'agent', '.agent.md', diagnostics)));
    content.prompts.push(
      ...(await readTextPrimitives(dir, '.apm/prompts', 'prompt', '.prompt.md', diagnostics)),
    );
    content.instructions.push(
      ...(await readTextPrimitives(dir, '.apm/instructions', 'instruction', '.instructions.md', diagnostics)),
    );
    content.hooks.push(...(await readHooks(dir, ['.apm/hooks', 'hooks'], diagnostics)));
    if (manifest) content.mcp.push(...manifest.mcp);
    if (hasRootSkill) {
      const s = await readRootSkill(dir, content.name, diagnostics);
      if (s) content.skills.push(s);
    }
  } else if (hasRootSkill) {
    content.layout = 'skill_bundle';
    const s = await readRootSkill(dir, fallbackName, diagnostics);
    if (s) {
      content.skills.push(s);
      if (s.description) content.description = s.description;
    }
  } else if (isPlugin) {
    content.layout = 'plugin';
    if (typeof pluginJson?.name === 'string') content.name = pluginJson.name;
    if (typeof pluginJson?.version === 'string') content.version = pluginJson.version;
    if (typeof pluginJson?.description === 'string') content.description = pluginJson.description;
    if (typeof pluginJson?.license === 'string') content.license = pluginJson.license;
    // req-pr-006 : une clé `skills` présente remplace la découverte conventionnelle.
    if (pluginJson && 'skills' in pluginJson) {
      const declared = Array.isArray(pluginJson.skills) ? pluginJson.skills : [pluginJson.skills];
      for (const d of declared) {
        if (typeof d !== 'string') continue;
        const rel = path.posix.normalize(d.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '');
        if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) continue;
        const direct = await readSkill(path.join(dir, rel), path.posix.basename(rel), rel, diagnostics);
        if (direct) content.skills.push(direct);
        else content.skills.push(...(await readSkillsDir(dir, rel, diagnostics)));
      }
    } else {
      content.skills.push(...(await readSkillsDir(dir, 'skills', diagnostics)));
    }
    content.agents.push(...(await readTextPrimitives(dir, 'agents', 'agent', '.md', diagnostics)));
    content.prompts.push(...(await readTextPrimitives(dir, 'commands', 'prompt', '.md', diagnostics)));
    content.hooks.push(...(await readHooks(dir, ['hooks'], diagnostics, ['hooks.json'])));
    const mcpJson =
      (await readJson(path.join(dir, '.mcp.json'))) ?? (await readJson(path.join(dir, 'mcp.json')));
    content.mcp.push(...mcpFromPluginConfig(mcpJson));
    if (pluginJson?.mcpServers && typeof pluginJson.mcpServers === 'object') {
      content.mcp.push(...mcpFromPluginConfig({ mcpServers: pluginJson.mcpServers }));
    }
  } else if (hasSkillsDir && (await readSkillsDir(dir, 'skills', [])).length > 0) {
    content.layout = 'skill_collection';
    content.skills.push(...(await readSkillsDir(dir, 'skills', diagnostics)));
  } else {
    const hooks = await readHooks(dir, ['.apm/hooks', 'hooks'], diagnostics);
    if (hooks.length === 0) {
      throw new AhubError(
        'PACKAGE_INVALID',
        t(
          '"{0}" contains no recognised package layout (apm.yml, .apm/, SKILL.md, skills/, plugin.json, hooks/)',
          [fallbackName],
        ),
      );
    }
    content.layout = 'hook_package';
    content.hooks.push(...hooks);
  }

  content.skills = dedupeByName(content.skills, t('skill'), diagnostics);
  content.agents = dedupeByName(content.agents, t('agent'), diagnostics);
  content.prompts = dedupeByName(content.prompts, t('command'), diagnostics);
  content.instructions = dedupeByName(content.instructions, t('instruction'), diagnostics);
  content.mcp = dedupeByName(content.mcp, t('MCP server'), diagnostics);

  // Fichiers sources retenus, pour le scan de sécurité et l'aperçu avant installation.
  const seen = new Set<string>();
  const add = (relPath: string, bytes: Buffer, executable = false): void => {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    content.sourceFiles.push({ relPath, bytes, executable });
  };
  if (existsSync(manifestPath) && (await isFile(manifestPath)))
    add(MANIFEST_FILE, await readFile(manifestPath));
  for (const s of content.skills) {
    for (const f of s.files)
      add(s.sourceDir === '.' ? f.relPath : `${s.sourceDir}/${f.relPath}`, f.bytes, f.executable);
  }
  for (const p of [...content.agents, ...content.prompts, ...content.instructions]) add(p.sourcePath, p.raw);
  for (const h of content.hooks) add(h.sourcePath, h.raw);
  for (const extra of ['.mcp.json', 'mcp.json', '.claude-plugin/plugin.json', 'plugin.json']) {
    const p = path.join(dir, extra);
    if (content.layout === 'plugin' && (await isFile(p))) add(extra, await readFile(p));
  }
  return content;
}

async function readRootSkill(
  dir: string,
  name: string,
  diagnostics: Diagnostic[],
): Promise<SkillPrimitive | undefined> {
  // Le nom du skill racine vient de son frontmatter s'il est valide, sinon du nom du paquet.
  const md = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
  const { frontmatter } = splitFrontmatter(md, 'SKILL.md');
  const fmName =
    typeof frontmatter?.name === 'string' && SKILL_NAME_RE.test(frontmatter.name)
      ? frontmatter.name
      : undefined;
  const skillName = fmName ?? name.split('/').pop()!;
  return readSkill(dir, skillName, '.', diagnostics);
}

/** Résumé sérialisable du contenu d'un paquet (sans les octets). */
export interface PackageSummary {
  layout: PackageLayout;
  name: string;
  version?: string;
  description?: string;
  license?: string;
  /** Cibles déclarées par le manifeste du paquet, s'il en déclare. */
  declaredTargets?: string[];
  skills: Array<{ name: string; description?: string; files: string[] }>;
  agents: string[];
  commands: string[];
  instructions: string[];
  hooks: Array<{ name: string; events: string[] }>;
  mcpServers: Array<{ name: string; transport?: string; command?: string; args?: string[]; url?: string }>;
}

export function summarizePackage(content: PackageContent): PackageSummary {
  const summary: PackageSummary = {
    layout: content.layout,
    name: content.name,
    skills: content.skills.map((s) => {
      const o: { name: string; description?: string; files: string[] } = {
        name: s.name,
        files: s.files.map((f) => f.relPath),
      };
      if (s.description) o.description = s.description;
      return o;
    }),
    agents: content.agents.map((a) => a.name),
    commands: content.prompts.map((p) => p.name),
    instructions: content.instructions.map((i) => i.name),
    hooks: content.hooks.map((h) => ({ name: h.name, events: Object.keys(h.events) })),
    mcpServers: content.mcp.map((m) => {
      const o: PackageSummary['mcpServers'][number] = { name: m.name };
      if (m.transport) o.transport = m.transport;
      if (m.command) o.command = m.command;
      if (m.args) o.args = m.args;
      if (m.url) o.url = m.url;
      return o;
    }),
  };
  if (content.version) summary.version = content.version;
  if (content.description) summary.description = content.description;
  if (content.license) summary.license = content.license;
  if (content.manifest?.targets) summary.declaredTargets = content.manifest.targets;
  return summary;
}
