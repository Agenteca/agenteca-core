import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ADAPTERS, detectTargets } from './adapters/index.js';
import type { ExecutableNotice, Scope } from './adapters/types.js';
import {
  applyDeploy,
  type ApplyOptions,
  type ApplyResult,
  type DeployPlan,
  type PackageOps,
  planFingerprint,
  prepareDeploy,
  type PreparedDeploy,
  type PriorPackageState,
} from './deploy.js';
import { canonicalDepString, type DepRef, depIdentity, parseDepString } from './depref.js';
import { AhubError, type Diagnostic } from './errors.js';
import { defaultCacheDir, type GitOptions } from './git.js';
import {
  emptyLockfile,
  entryIdentity,
  LEGACY_LOCK_FILE,
  LOCK_FILE,
  type LockEntry,
  type Lockfile,
  parseLockfile,
  serializeLockfile,
} from './lockfile.js';
import { MANIFEST_FILE, ManifestFile, SUPPORTED_TARGETS, type Target } from './manifest.js';
import { type PackageSummary, summarizePackage } from './package.js';
import { checkOutdated, type OutdatedInfo, resolveAll, type ResolvedPackage } from './resolver.js';
import { type Finding, hasBlocking, scanFiles } from './scan.js';

export const AHUB_VERSION = '0.1.0';

export interface ProjectContext {
  /** Racine de déploiement : dossier du projet, ou dossier personnel en portée utilisateur. */
  root: string;
  scope: Scope;
  home: string;
  manifestPath: string;
  lockPath: string;
  git: GitOptions;
  now?: () => Date;
}

/**
 * Contexte d'exécution. Portée utilisateur : manifeste et lockfile dans
 * `~/.apm/` (même emplacement que `apm -g`, déclaré dans CONFORMANCE.md, req-tg-014).
 */
export function createContext(opts: {
  cwd: string;
  global?: boolean;
  env?: NodeJS.ProcessEnv;
}): ProjectContext {
  const env = opts.env ?? process.env;
  const home = env.AHUB_HOME || os.homedir();
  const git: GitOptions = { cacheDir: defaultCacheDir(env) };
  if (env.AHUB_GIT_MIRRORS) {
    try {
      git.mirrors = JSON.parse(env.AHUB_GIT_MIRRORS) as Record<string, string>;
    } catch {
      throw new AhubError(
        'USAGE',
        'AHUB_GIT_MIRRORS doit être un objet JSON { "hôte/propriétaire/dépôt": "url" }',
      );
    }
  }
  if (opts.global) {
    const dir = env.AHUB_USER_DIR || path.join(home, '.apm');
    return {
      root: home,
      scope: 'user',
      home,
      manifestPath: path.join(dir, MANIFEST_FILE),
      lockPath: path.join(dir, LOCK_FILE),
      git,
    };
  }
  const root = path.resolve(opts.cwd);
  return {
    root,
    scope: 'project',
    home,
    manifestPath: path.join(root, MANIFEST_FILE),
    lockPath: path.join(root, LOCK_FILE),
    git,
  };
}

export async function loadManifest(ctx: ProjectContext): Promise<ManifestFile | undefined> {
  if (!existsSync(ctx.manifestPath)) return undefined;
  return ManifestFile.parse(await readFile(ctx.manifestPath, 'utf8'), MANIFEST_FILE);
}

export async function loadLock(ctx: ProjectContext): Promise<Lockfile | undefined> {
  if (existsSync(ctx.lockPath)) return parseLockfile(await readFile(ctx.lockPath, 'utf8'), LOCK_FILE);
  const legacy = path.join(path.dirname(ctx.lockPath), LEGACY_LOCK_FILE);
  if (existsSync(legacy)) return parseLockfile(await readFile(legacy, 'utf8'), LEGACY_LOCK_FILE);
  return undefined;
}

export interface InstallRequest {
  add?: DepRef[];
  /** Dépendances directes à retirer (identité, `propriétaire/dépôt` ou nom court). */
  remove?: string[];
  /** Dépendances directes à résoudre de nouveau ; `all` pour toutes. */
  update?: string[] | 'all';
  frozen?: boolean;
  targets?: Target[];
  legacySkillPaths?: boolean;
  /** Crée le manifeste s'il n'existe pas (cas de `ahub add` dans un projet vierge). */
  initName?: string;
}

export interface PackageReport {
  identity: string;
  name: string;
  version?: string;
  source: 'git' | 'local';
  ref?: string;
  commit?: string;
  resolvedTag?: string;
  depth: number;
  direct: boolean;
  /** Changement par rapport au lockfile précédent. */
  change: 'added' | 'updated' | 'unchanged';
  previousCommit?: string;
  targets: Target[];
  summary: PackageSummary;
}

export interface PreparedInstall {
  ctx: ProjectContext;
  targets: Target[];
  packages: PackageReport[];
  removedPackages: string[];
  plan: DeployPlan;
  findings: Finding[];
  /** Vrai si un constat critique interdit le déploiement sans contournement explicite. */
  blocked: boolean;
  executables: ExecutableNotice[];
  diagnostics: Diagnostic[];
  planHash: string;
  manifestText: string;
  manifestChanged: boolean;
  /** Internes, non sérialisables. */
  internal: {
    prepared: PreparedDeploy;
    resolved: ResolvedPackage[];
    previousLock?: Lockfile;
    workDir: string;
    mcpConfigs: Record<string, unknown>;
  };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'pkg'
  );
}

/** Détermine les cibles : option explicite > manifeste > détection (matrice APM). Échec fermé sinon. */
export function selectTargets(
  ctx: ProjectContext,
  explicit: Target[] | undefined,
  declared: string[] | undefined,
  diagnostics: Diagnostic[],
): Target[] {
  const supported = SUPPORTED_TARGETS as readonly string[];
  if (explicit && explicit.length > 0) return [...new Set(explicit)];
  if (declared && declared.length > 0) {
    if (declared.includes('all')) return [...SUPPORTED_TARGETS];
    const out: Target[] = [];
    for (const t of declared) {
      if (supported.includes(t)) out.push(t as Target);
      else
        diagnostics.push({
          code: 'TARGET_UNSUPPORTED',
          message: `cible « ${t} » déclarée dans apm.yml : pas d’adaptateur dans ahub, ignorée`,
        });
    }
    if (out.length > 0) return out;
  }
  const detected = detectTargets(ctx.root, ctx.scope);
  if (detected.length > 0) return detected;
  throw new AhubError(
    'NO_TARGET',
    'aucun outil cible détecté. Indiquez-le avec --tool (claude, codex, copilot, cursor) ou déclarez « targets: » dans apm.yml.',
  );
}

function priorStates(lock: Lockfile | undefined): PriorPackageState[] {
  if (!lock) return [];
  return lock.dependencies.map((e) => {
    const files: Record<string, string> = {};
    for (const f of e.deployed_files ?? []) files[f] = e.deployed_file_hashes?.[f] ?? '';
    return { identity: entryIdentity(e), files, merged: e['x-ahub']?.merged ?? [] };
  });
}

/**
 * Prépare une installation sans rien écrire : résolution, lecture des paquets,
 * scan de sécurité, plan de déploiement. Le résultat est ce qui est montré à
 * l'utilisateur avant confirmation.
 */
export async function prepareInstall(
  ctx: ProjectContext,
  req: InstallRequest = {},
): Promise<PreparedInstall> {
  const diagnostics: Diagnostic[] = [];
  let manifestFile = await loadManifest(ctx);
  const originalText = manifestFile?.toString();
  if (!manifestFile) {
    if (!req.initName) {
      throw new AhubError(
        'NOT_FOUND',
        `aucun ${MANIFEST_FILE} dans ${path.dirname(ctx.manifestPath)}. Lancez « ahub init » ou « ahub add <paquet> ».`,
      );
    }
    const init: { name: string; targets?: string[] } = { name: req.initName };
    if (req.targets && req.targets.length > 0) init.targets = req.targets;
    manifestFile = ManifestFile.create(init);
  }
  diagnostics.push(...manifestFile.manifest.diagnostics);
  const previousLock = await loadLock(ctx);
  if (req.frozen && !previousLock) {
    throw new AhubError('LOCK_MISMATCH', `installation figée demandée, mais ${LOCK_FILE} est absent`);
  }

  const refresh = new Set<string>();
  for (const ref of req.add ?? []) {
    manifestFile.setApmDependency(ref);
    refresh.add(depIdentity(ref));
  }
  for (const query of req.remove ?? []) {
    const dep = manifestFile.findDependency(query);
    if (!dep)
      throw new AhubError('NOT_FOUND', `« ${query} » n’est pas une dépendance directe de ce projet`, {
        query,
      });
    manifestFile.removeApmDependency(depIdentity(dep));
  }
  let refreshAll = false;
  if (req.update === 'all') refreshAll = true;
  else {
    for (const query of req.update ?? []) {
      const dep = manifestFile.findDependency(query);
      if (!dep)
        throw new AhubError('NOT_FOUND', `« ${query} » n’est pas une dépendance directe de ce projet`, {
          query,
        });
      refresh.add(depIdentity(dep));
    }
  }

  const manifest = manifestFile.manifest;
  const targets = selectTargets(ctx, req.targets, manifest.targets, diagnostics);
  const locked = new Map<string, LockEntry>();
  for (const e of previousLock?.dependencies ?? []) locked.set(entryIdentity(e), e);

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'ahub-work-'));
  try {
    const { packages: resolved, diagnostics: rd } = await resolveAll(manifest, {
      git: ctx.git,
      projectRoot: ctx.scope === 'user' ? path.dirname(ctx.manifestPath) : ctx.root,
      home: ctx.home,
      workDir,
      locked,
      refresh: refreshAll ? 'all' : refresh,
      ...(ctx.now ? { now: ctx.now } : {}),
      ...(req.frozen ? { frozen: true } : {}),
    });
    diagnostics.push(...rd);

    const ops: PackageOps[] = [];
    const reports: PackageReport[] = [];
    const executables: ExecutableNotice[] = [];
    const scanInputs: Array<{ path: string; bytes: Buffer }> = [];
    const mcpConfigs: Record<string, unknown> = {};

    for (const pkg of resolved) {
      let pkgTargets = targets;
      if (pkg.ref.targets && pkg.ref.targets.length > 0) {
        pkgTargets = targets.filter((t) => pkg.ref.targets!.includes(t));
      }
      if (pkg.ref.skills && pkg.ref.skills.length > 0) {
        const available = pkg.content.skills.map((s) => s.name);
        if (!pkg.ref.skills.some((s) => available.includes(s))) {
          // req-mf-022 : une sélection insatisfaite n'est jamais une demande de retrait.
          throw new AhubError(
            'RESOLUTION_FAILED',
            `${pkg.identity} : aucun des skills demandés (${pkg.ref.skills.join(', ')}) n’existe. Disponibles : ${available.join(', ') || 'aucun'}.`,
            { identity: pkg.identity, requested: pkg.ref.skills, available },
          );
        }
      }
      const packageOps: PackageOps = {
        identity: pkg.identity,
        name: pkg.content.name,
        files: [],
        merges: [],
      };
      for (const target of pkgTargets) {
        const res = ADAPTERS[target](pkg.content, {
          scope: ctx.scope,
          packageSlug: slug(pkg.content.name),
          ...(req.legacySkillPaths ? { legacySkillPaths: true } : {}),
          ...(pkg.ref.skills ? { skillSubset: pkg.ref.skills } : {}),
        });
        packageOps.files.push(...res.files);
        packageOps.merges.push(...res.merges);
        executables.push(...res.executables);
        diagnostics.push(...res.diagnostics);
      }
      ops.push(packageOps);
      for (const f of pkg.content.sourceFiles)
        scanInputs.push({ path: `${pkg.content.name}/${f.relPath}`, bytes: f.bytes });
      for (const m of pkg.content.mcp) if (m.registry === false) mcpConfigs[m.name] = { ...m };

      const prev = locked.get(pkg.identity);
      const report: PackageReport = {
        identity: pkg.identity,
        name: pkg.content.name,
        source: pkg.source,
        depth: pkg.depth,
        direct: pkg.depth === 1,
        change: !prev
          ? 'added'
          : prev.resolved_commit !== pkg.commit || prev.content_hash !== pkg.contentHash
            ? 'updated'
            : 'unchanged',
        targets: pkgTargets,
        summary: summarizePackage(pkg.content),
      };
      if (pkg.content.version) report.version = pkg.content.version;
      if (pkg.ref.ref) report.ref = pkg.ref.ref;
      if (pkg.commit) report.commit = pkg.commit;
      if (pkg.resolvedTag) report.resolvedTag = pkg.resolvedTag;
      if (prev?.resolved_commit && prev.resolved_commit !== pkg.commit)
        report.previousCommit = prev.resolved_commit;
      reports.push(report);
    }

    const findings = scanFiles(scanInputs);
    const prepared = await prepareDeploy(ctx.root, ops, priorStates(previousLock));
    const resolvedIds = new Set(resolved.map((p) => p.identity));
    const removedPackages = [...locked.keys()].filter((id) => !resolvedIds.has(id));
    const manifestText = manifestFile.toString();

    return {
      ctx,
      targets,
      packages: reports,
      removedPackages,
      plan: prepared.plan,
      findings,
      blocked: hasBlocking(findings),
      executables,
      diagnostics: dedupeDiagnostics(diagnostics),
      planHash: planFingerprint(prepared.plan, {
        findings: findings.map((f) => [f.ruleId, f.path, f.line]),
        executables: executables.map((e) => [e.kind, e.target, e.name, e.detail, e.command]),
        packages: reports.map((r) => [r.identity, r.commit ?? null]),
      }),
      manifestText,
      manifestChanged: manifestText !== originalText,
      internal: { prepared, resolved, workDir, mcpConfigs, ...(previousLock ? { previousLock } : {}) },
    };
  } catch (e) {
    await rm(workDir, { recursive: true, force: true });
    throw e;
  }
}

function dedupeDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.code}\u0000${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function discardInstall(prepared: PreparedInstall): Promise<void> {
  await rm(prepared.internal.workDir, { recursive: true, force: true });
}

export interface InstallOptions extends ApplyOptions {
  /** Contournement explicite du refus sur constat critique. */
  allowUnsafe?: boolean;
}

export interface InstallResult extends ApplyResult {
  lockfile: Lockfile;
}

/** Applique une installation préparée, puis écrit le manifeste et le lockfile. */
export async function applyInstall(p: PreparedInstall, opts: InstallOptions = {}): Promise<InstallResult> {
  const { ctx } = p;
  try {
    if (p.blocked && !opts.allowUnsafe) {
      throw new AhubError(
        'SCAN_BLOCKED',
        'le scan de sécurité a relevé des constats critiques : déploiement refusé (contournement explicite : --allow-unsafe)',
        {
          findings: p.findings.filter((f) => f.severity === 'critical'),
        },
      );
    }
    const fileConflicts = p.plan.conflicts.filter((c) => c.reason !== 'merge');
    const uncovered = fileConflicts.filter(
      (c) => !(opts.overwrite === 'all' || (opts.overwrite instanceof Set && opts.overwrite.has(c.path))),
    );
    if (uncovered.length > 0) {
      throw new AhubError(
        'FILE_MODIFIED',
        `${uncovered.length} fichier(s) modifié(s) à la main ou non géré(s) : rien n’a été écrit`,
        { conflicts: uncovered },
      );
    }

    const applied = await applyDeploy(p.internal.prepared, opts);
    const previous = p.internal.previousLock;
    const prevById = new Map<string, LockEntry>();
    for (const e of previous?.dependencies ?? []) prevById.set(entryIdentity(e), e);

    const lock: Lockfile = { ...(previous ?? emptyLockfile()), dependencies: [] };
    const mcpNames = new Set<string>();
    for (const pkg of p.internal.resolved) {
      const record = p.internal.prepared.records.get(pkg.identity)!;
      const report = p.packages.find((r) => r.identity === pkg.identity)!;
      // Les champs inconnus de l'entrée précédente sont conservés (req-lk-011).
      const entry: LockEntry = { ...(prevById.get(pkg.identity) ?? {}) };
      for (const k of [
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
        'resolved_by',
        'is_dev',
        'skill_subset',
        'alias',
        'version',
        'declared_license',
      ]) {
        delete entry[k];
      }
      if (pkg.source === 'git') {
        entry.repo_url = pkg.ref.repoUrl!;
        if (pkg.ref.port) entry.port = pkg.ref.port;
        if (pkg.resolvedRef !== undefined) entry.resolved_ref = pkg.resolvedRef;
        entry.resolved_commit = pkg.commit!;
        entry.tree_sha256 = pkg.treeSha256!;
        if (pkg.constraint) entry.constraint = pkg.constraint;
        if (pkg.resolvedTag) entry.resolved_tag = pkg.resolvedTag;
        if (pkg.resolvedAt) entry.resolved_at = pkg.resolvedAt;
        if (pkg.ref.virtualPath) {
          entry.virtual_path = pkg.ref.virtualPath;
          entry.is_virtual = true;
        }
      } else {
        entry.source = 'local';
        entry.local_path = pkg.localPath!;
        entry.content_hash = pkg.contentHash!;
        // La spec ne l'exige que pour git, mais l'outil apm (0.35.0) refuse un lockfile dont une
        // entrée locale n'a pas de `repo_url` ; il écrit lui-même `_local/<dossier>`.
        entry.repo_url = `_local/${path.basename(pkg.dir)}`;
      }
      entry.name = pkg.content.name;
      if (pkg.content.version) entry.version = pkg.content.version;
      if (pkg.content.license) entry.declared_license = pkg.content.license;
      entry.depth = pkg.depth;
      if (pkg.resolvedBy) entry.resolved_by = pkg.resolvedBy;
      if (pkg.isDev) entry.is_dev = true;
      entry.package_type = pkg.content.layout;
      if (pkg.ref.alias) entry.alias = pkg.ref.alias;
      if (pkg.ref.skills) entry.skill_subset = pkg.ref.skills;
      entry.deployed_files = Object.keys(record.files).sort();
      entry.deployed_file_hashes = record.files;
      const ext: NonNullable<LockEntry['x-ahub']> = { targets: report.targets };
      if (record.merged.length > 0) ext.merged = record.merged;
      entry['x-ahub'] = ext;
      for (const m of record.merged) {
        if (m.kind === 'mcp') for (const e of m.entries) mcpNames.add(e.keyPath[e.keyPath.length - 1]!);
      }
      lock.dependencies.push(entry);
    }
    if (mcpNames.size > 0) {
      lock.mcp_servers = [...mcpNames].sort();
      lock.mcp_configs = Object.fromEntries(
        [...mcpNames].sort().map((n) => [n, p.internal.mcpConfigs[n] ?? {}]),
      );
    } else {
      delete lock.mcp_servers;
      delete lock.mcp_configs;
    }

    await mkdir(path.dirname(ctx.manifestPath), { recursive: true });
    if (p.manifestChanged) await writeFile(ctx.manifestPath, p.manifestText);
    await writeFile(ctx.lockPath, serializeLockfile(lock, previous));
    return { ...applied, lockfile: lock };
  } finally {
    await discardInstall(p);
  }
}

export interface InstalledPackage {
  identity: string;
  name: string;
  version?: string;
  source: 'git' | 'local';
  ref?: string;
  commit?: string;
  resolvedTag?: string;
  direct: boolean;
  targets: string[];
  files: string[];
  mergedFiles: string[];
}

export function listInstalled(lock: Lockfile | undefined): InstalledPackage[] {
  return (lock?.dependencies ?? []).map((e) => {
    const p: InstalledPackage = {
      identity: entryIdentity(e),
      name: e.name ?? entryIdentity(e),
      source: e.source === 'local' ? 'local' : 'git',
      direct: (e.depth ?? 1) === 1,
      targets: e['x-ahub']?.targets ?? [],
      files: e.deployed_files ?? [],
      mergedFiles: (e['x-ahub']?.merged ?? []).map((m) => m.path),
    };
    if (e.version) p.version = e.version;
    if (e.resolved_ref) p.ref = e.resolved_ref;
    if (e.resolved_commit) p.commit = e.resolved_commit;
    if (e.resolved_tag) p.resolvedTag = e.resolved_tag;
    return p;
  });
}

export async function listOutdated(ctx: ProjectContext): Promise<OutdatedInfo[]> {
  const manifestFile = await loadManifest(ctx);
  if (!manifestFile)
    throw new AhubError('NOT_FOUND', `aucun ${MANIFEST_FILE} dans ${path.dirname(ctx.manifestPath)}`);
  const lock = await loadLock(ctx);
  const byId = new Map<string, LockEntry>();
  for (const e of lock?.dependencies ?? []) byId.set(entryIdentity(e), e);
  const out: OutdatedInfo[] = [];
  for (const ref of manifestFile.manifest.apm) {
    const info = await checkOutdated(ref, byId.get(depIdentity(ref)), ctx.git);
    if (info) out.push(info);
  }
  return out;
}

export interface InspectedFile {
  path: string;
  size: number;
  /** Contenu texte, absent pour les fichiers binaires ou trop gros. */
  text?: string;
}

export interface PackageInspection {
  dep: string;
  identity: string;
  commit?: string;
  resolvedTag?: string;
  treeSha256?: string;
  summary: PackageSummary;
  dependencies: string[];
  files: InspectedFile[];
  findings: Finding[];
  blocked: boolean;
  diagnostics: Diagnostic[];
}

/** Résout et lit un paquet sans rien installer : contenu visible avant installation. */
export async function inspectPackage(
  ctx: ProjectContext,
  dep: string,
  opts: { includeText?: boolean } = {},
): Promise<PackageInspection> {
  const ref = parseDepString(dep);
  const manifest = ManifestFile.create({ name: 'inspect' });
  manifest.setApmDependency(ref);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'ahub-inspect-'));
  try {
    const { packages } = await resolveAll(manifest.manifest, {
      git: ctx.git,
      projectRoot: ctx.root,
      home: ctx.home,
      workDir,
      transitive: false,
    });
    const pkg = packages.find((p) => p.identity === depIdentity(ref)) ?? packages[0]!;
    const inputs = pkg.content.sourceFiles.map((f) => ({ path: f.relPath, bytes: f.bytes }));
    const findings = scanFiles(inputs);
    const out: PackageInspection = {
      dep: canonicalDepString(ref),
      identity: pkg.identity,
      summary: summarizePackage(pkg.content),
      dependencies: (pkg.content.manifest?.apm ?? []).map((d) => canonicalDepString(d)),
      files: pkg.content.sourceFiles.map((f) => {
        const file: InspectedFile = { path: f.relPath, size: f.bytes.length };
        if (opts.includeText && f.bytes.length <= 256 * 1024 && !f.bytes.includes(0))
          file.text = f.bytes.toString('utf8');
        return file;
      }),
      findings,
      blocked: hasBlocking(findings),
      diagnostics: pkg.content.diagnostics,
    };
    if (pkg.commit) out.commit = pkg.commit;
    if (pkg.resolvedTag) out.resolvedTag = pkg.resolvedTag;
    if (pkg.treeSha256) out.treeSha256 = pkg.treeSha256;
    return out;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
