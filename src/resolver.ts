import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { cloneUrl, type DepRef, depIdentity, isVirtualFile } from './depref.js';
import { AhubError, type Diagnostic } from './errors.js';
import {
  ensureMirror,
  type GitOptions,
  hasCommit,
  lsRemote,
  materialize,
  type RemoteRefs,
  treeSha256,
} from './git.js';
import { envelope, sha256Hex } from './hash.js';
import type { LockEntry } from './lockfile.js';
import type { Manifest } from './manifest.js';
import { type PackageContent, readPackage } from './package.js';
import { t } from './i18n.js';

export interface ResolveOptions {
  git: GitOptions;
  /** Folder of the root manifest: base of local paths. */
  projectRoot: string;
  home: string;
  /** Working folder where packages are materialised. */
  workDir: string;
  now?: () => Date;
  maxDepth?: number;
  /** Lockfile entries by identity: replayed as is unless refreshed. */
  locked?: Map<string, LockEntry>;
  /** Identities to resolve again ignoring the lockfile; `all` for every one. */
  refresh?: Set<string> | 'all';
  /** Frozen installation: the lockfile is authoritative, any divergence is an error. */
  frozen?: boolean;
  includeDev?: boolean;
  /** `false`: does not follow the dependencies of packages (inspection of a single package). */
  transitive?: boolean;
}

export interface ResolvedPackage {
  identity: string;
  ref: DepRef;
  depth: number;
  resolvedBy?: string;
  isDev: boolean;
  source: 'git' | 'local';
  commit?: string;
  resolvedRef?: string;
  constraint?: string;
  resolvedTag?: string;
  resolvedAt?: string;
  treeSha256?: string;
  localPath?: string;
  contentHash?: string;
  dir: string;
  content: PackageContent;
}

export type RefKind = 'semver' | 'literal' | 'none';

const LITERAL_TAG_RE = /^v?\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** Classifies a git reference (req-rs-003): SemVer range, literal, or absent. */
export function classifyRef(ref: string | undefined): RefKind {
  if (ref === undefined || ref === '') return 'none';
  if (SHA_RE.test(ref) || LITERAL_TAG_RE.test(ref)) return 'literal';
  // node-semver dialect required by the spec (req-rs-007).
  return semver.validRange(ref) !== null && /[\d*xX]/.test(ref) ? 'semver' : 'literal';
}

/** Candidate tags: `v{version}`, `{version}` or `{name}--v{version}`; the others are dropped silently. */
export function versionsFromTags(tags: Iterable<string>, packageName: string): Map<string, string> {
  const out = new Map<string, string>();
  const prefix = `${packageName}--v`;
  for (const tag of tags) {
    let v: string | undefined;
    if (tag.startsWith(prefix)) v = tag.slice(prefix.length);
    else if (/^v?\d/.test(tag)) v = tag.replace(/^v/, '');
    if (!v) continue;
    const parsed = semver.valid(v);
    if (parsed && (!out.has(parsed) || tag.startsWith(prefix))) out.set(parsed, tag);
  }
  return out;
}

function packageShortName(ref: DepRef): string {
  return ref.virtualPath ? ref.virtualPath.split('/').pop()! : ref.repo!;
}

export function repoLocation(ref: DepRef, git: GitOptions): string {
  return git.mirrors?.[ref.repoUrl!] ?? cloneUrl(ref);
}

interface Request {
  ref: DepRef;
  depth: number;
  by?: string;
  isDev: boolean;
  /** Folder of the declaring package (for local paths) and its allowed root. */
  baseDir: string;
  boundary?: string;
}

class Restart extends Error {}

/**
 * Resolves the dependency graph of a manifest: breadth-first walk,
 * intersection of SemVer ranges across chains (req-rs-001), fails closed if
 * the intersection is empty.
 */
export async function resolveAll(
  manifest: Manifest,
  opts: ResolveOptions,
): Promise<{ packages: ResolvedPackage[]; diagnostics: Diagnostic[] }> {
  const constraints = new Map<string, Set<string>>();
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await resolveOnce(manifest, opts, constraints);
    } catch (e) {
      if (!(e instanceof Restart)) throw e;
    }
  }
  throw new AhubError('RESOLUTION_FAILED', t('dependency resolution does not converge'));
}

async function resolveOnce(
  manifest: Manifest,
  opts: ResolveOptions,
  constraints: Map<string, Set<string>>,
): Promise<{ packages: ResolvedPackage[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const resolved = new Map<string, ResolvedPackage>();
  const remoteCache = new Map<string, RemoteRefs>();
  const maxDepth = opts.maxDepth ?? 50;
  const now = opts.now ?? (() => new Date());

  const queue: Request[] = manifest.apm.map((ref) => ({
    ref,
    depth: 1,
    isDev: false,
    baseDir: opts.projectRoot,
  }));
  if (opts.includeDev !== false) {
    queue.push(...manifest.devApm.map((ref) => ({ ref, depth: 1, isDev: true, baseDir: opts.projectRoot })));
  }

  const remoteRefs = async (url: string): Promise<RemoteRefs> => {
    let r = remoteCache.get(url);
    if (!r) {
      r = await lsRemote(url);
      remoteCache.set(url, r);
    }
    return r;
  };

  while (queue.length > 0) {
    const req = queue.shift()!;
    const { ref } = req;
    if (ref.kind === 'registry') {
      throw new AhubError(
        'UNSUPPORTED',
        t('registry dependency "{0}": not supported in v0.1', [ref.registryId]),
      );
    }
    if (req.depth > maxDepth) {
      throw new AhubError(
        'RESOLUTION_FAILED',
        t('maximum depth ({0}) exceeded while resolving {1}', [maxDepth, depIdentity(ref)]),
      );
    }

    let pkg: ResolvedPackage;
    if (ref.kind === 'local') {
      const abs = resolveLocalPath(ref.localPath!, req.baseDir, opts.home);
      if (req.boundary && !isInside(req.boundary, abs)) {
        throw new AhubError(
          'RESOLUTION_FAILED',
          t('local path "{0}" leaves the repository that declares it', [ref.localPath]),
        );
      }
      const identity = req.boundary ? `local:${abs}` : depIdentity(ref);
      if (resolved.has(identity)) continue;
      const content = await readPackage(abs, path.basename(abs));
      const contentHash = envelope(
        sha256Hex(
          content.sourceFiles
            .map((f) => `${f.relPath}\u0000${sha256Hex(f.bytes)}`)
            .sort()
            .join('\n'),
        ),
      );
      pkg = {
        identity,
        ref,
        depth: req.depth,
        isDev: req.isDev,
        source: 'local',
        localPath: ref.localPath!,
        contentHash,
        dir: abs,
        content,
      };
      if (req.by) pkg.resolvedBy = req.by;
    } else {
      const identity = depIdentity(ref);
      const kind = classifyRef(ref.ref);
      const existing = resolved.get(identity);

      if (kind === 'semver') {
        const set = constraints.get(identity) ?? new Set<string>();
        const isNew = !set.has(ref.ref!);
        set.add(ref.ref!);
        constraints.set(identity, set);
        if (existing) {
          const version = existing.resolvedTag
            ? semver.valid(existing.resolvedTag.replace(/^.*--v|^v/, ''))
            : null;
          if (isNew && (!version || !semver.satisfies(version, ref.ref!))) throw new Restart();
          continue;
        }
      } else if (existing) {
        if ((existing.ref.ref ?? '') !== (ref.ref ?? '') && existing.depth > 1 && req.depth > 1) {
          throw new AhubError(
            'RESOLUTION_FAILED',
            t('incompatible versions for {0}: "{1}" (via {2}) and "{3}" (via {4})', [
              identity,
              existing.ref.ref ?? t('default'),
              existing.resolvedBy,
              ref.ref ?? t('default'),
              req.by,
            ]),
          );
        }
        if ((existing.ref.ref ?? '') !== (ref.ref ?? '')) {
          diagnostics.push({
            code: 'DEPENDENCY_REF_OVERRIDDEN',
            message: t('{0}: reference "{1}" requested by {2} is overridden by "{3}"', [
              identity,
              ref.ref ?? t('default'),
              req.by ?? t('the manifest'),
              existing.ref.ref ?? t('default'),
            ]),
          });
        }
        continue;
      }

      pkg = await resolveGit(req, identity, kind, constraints.get(identity), opts, remoteRefs, now);
    }

    resolved.set(pkg.identity, pkg);
    diagnostics.push(
      ...pkg.content.diagnostics.map((d) => ({
        ...d,
        message: t('{0}: {1}', [pkg.content.name, d.message]),
      })),
    );
    for (const child of opts.transitive === false ? [] : (pkg.content.manifest?.apm ?? [])) {
      const childReq: Request = {
        ref: child,
        depth: req.depth + 1,
        by: pkg.identity,
        isDev: req.isDev,
        baseDir: pkg.dir,
      };
      if (pkg.source === 'git') childReq.boundary = repoRootOf(pkg);
      queue.push(childReq);
    }
  }
  return { packages: [...resolved.values()], diagnostics };
}

function repoRootOf(pkg: ResolvedPackage): string {
  if (!pkg.ref.virtualPath) return pkg.dir;
  const depth = pkg.ref.virtualPath.split('/').length;
  return path.resolve(pkg.dir, ...Array(depth).fill('..'));
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveLocalPath(localPath: string, baseDir: string, home: string): string {
  if (localPath.startsWith('~/')) return path.resolve(home, localPath.slice(2));
  return path.resolve(baseDir, localPath);
}

async function resolveGit(
  req: Request,
  identity: string,
  kind: RefKind,
  ranges: Set<string> | undefined,
  opts: ResolveOptions,
  remoteRefs: (url: string) => Promise<RemoteRefs>,
  now: () => Date,
): Promise<ResolvedPackage> {
  const { ref } = req;
  const url = repoLocation(ref, opts.git);
  const pkg: Partial<ResolvedPackage> = { identity, ref, depth: req.depth, isDev: req.isDev, source: 'git' };
  if (req.by) pkg.resolvedBy = req.by;

  const lock = opts.locked?.get(identity);
  const refreshed = opts.refresh === 'all' || (opts.refresh instanceof Set && opts.refresh.has(identity));
  const lockMatches =
    lock?.resolved_commit !== undefined &&
    (lock.constraint ?? lock.resolved_ref ?? '') === (ref.ref ?? lock.resolved_ref ?? '') &&
    // An extra range coming from another chain must still be satisfied by the locked version.
    (kind !== 'semver' || lockSatisfies(lock, ranges));

  if (opts.frozen && !lockMatches) {
    throw new AhubError(
      'LOCK_MISMATCH',
      t('frozen install: {0} is missing from the lockfile or no longer matches the manifest', [identity]),
      { identity },
    );
  }

  if (lockMatches && !refreshed) {
    pkg.commit = lock!.resolved_commit!;
    if (lock!.resolved_ref !== undefined) pkg.resolvedRef = lock!.resolved_ref;
    if (lock!.constraint !== undefined) pkg.constraint = lock!.constraint;
    if (lock!.resolved_tag !== undefined) pkg.resolvedTag = lock!.resolved_tag;
    if (lock!.resolved_at !== undefined) pkg.resolvedAt = lock!.resolved_at;
  } else if (kind === 'semver') {
    const refs = await remoteRefs(url);
    const versions = versionsFromTags(refs.tags.keys(), packageShortName(ref));
    const combined = [...(ranges ?? new Set([ref.ref!]))].join(' ');
    const best = semver.maxSatisfying([...versions.keys()], combined);
    if (!best) {
      throw new AhubError(
        'RESOLUTION_FAILED',
        t('no tag of {0} satisfies {1}', [
          identity,
          [...(ranges ?? [ref.ref!])].map((r) => `"${r}"`).join(', '),
        ]),
        { identity, ranges: [...(ranges ?? [])] },
      );
    }
    const tag = versions.get(best)!;
    pkg.commit = refs.tags.get(tag)!;
    pkg.resolvedRef = ref.ref!;
    pkg.constraint = ref.ref!;
    pkg.resolvedTag = tag;
    pkg.resolvedAt = now()
      .toISOString()
      .replace(/\.\d{3}Z$/, '+00:00');
  } else if (kind === 'literal' && SHA_RE.test(ref.ref!)) {
    pkg.commit = ref.ref!;
    pkg.resolvedRef = ref.ref!;
  } else {
    const refs = await remoteRefs(url);
    if (kind === 'none') {
      if (!refs.head)
        throw new AhubError('RESOLUTION_FAILED', t('{0}: the repository has no default branch', [identity]));
      pkg.commit = refs.head;
      if (refs.defaultBranch) pkg.resolvedRef = refs.defaultBranch;
    } else {
      const commit = refs.tags.get(ref.ref!) ?? refs.branches.get(ref.ref!);
      if (!commit)
        throw new AhubError(
          'RESOLUTION_FAILED',
          t('{0}: reference "{1}" does not exist (neither a tag nor a branch)', [identity, ref.ref]),
          { identity },
        );
      pkg.commit = commit;
      pkg.resolvedRef = ref.ref!;
    }
  }

  let gitDir = await ensureMirror(url, opts.git, false);
  if (!(await hasCommit(gitDir, pkg.commit!))) {
    gitDir = await ensureMirror(url, opts.git, true);
    if (!(await hasCommit(gitDir, pkg.commit!))) {
      throw new AhubError(
        'RESOLUTION_FAILED',
        t('{0}: commit {1} cannot be found in the repository', [identity, pkg.commit]),
        { identity },
      );
    }
  }

  pkg.treeSha256 = envelope(await treeSha256(gitDir, pkg.commit!));
  if (lockMatches && !refreshed && lock!.tree_sha256 && lock!.tree_sha256 !== pkg.treeSha256) {
    // req-lk-015: fails closed if the tree no longer matches the recorded hash.
    throw new AhubError(
      'LOCK_MISMATCH',
      t('{0}: expected tree_sha256 {1}, observed {2}', [identity, lock!.tree_sha256, pkg.treeSha256]),
      { identity, expected: lock!.tree_sha256, actual: pkg.treeSha256 },
    );
  }

  const repoDir = path.join(opts.workDir, sha256Hex(`${ref.repoUrl}@${pkg.commit}`).slice(0, 24));
  await materialize(gitDir, pkg.commit!, repoDir);

  const shortName = packageShortName(ref);
  if (ref.virtualPath && isVirtualFile(ref.virtualPath)) {
    // Single-file virtual package (req-mf-008): rebuilt as a minimal package.
    const base = path.posix.basename(ref.virtualPath);
    const sub = base.endsWith('.agent.md')
      ? 'agents'
      : base.endsWith('.prompt.md')
        ? 'prompts'
        : 'instructions';
    const synthetic = path.join(opts.workDir, `${sha256Hex(`${identity}@${pkg.commit}`).slice(0, 24)}-file`);
    await mkdir(path.join(synthetic, '.apm', sub), { recursive: true });
    await copyFile(
      path.join(repoDir, ...ref.virtualPath.split('/')),
      path.join(synthetic, '.apm', sub, base),
    );
    pkg.dir = synthetic;
    pkg.content = await readPackage(synthetic, base.replace(/\.(agent|prompt|instructions)\.md$/, ''));
  } else {
    pkg.dir = ref.virtualPath ? path.join(repoDir, ...ref.virtualPath.split('/')) : repoDir;
    pkg.content = await readPackage(pkg.dir, shortName);
  }
  return pkg as ResolvedPackage;
}

function lockSatisfies(lock: LockEntry, ranges: Set<string> | undefined): boolean {
  if (!ranges || ranges.size === 0) return true;
  if (!lock.resolved_tag) return false;
  const v = semver.valid(lock.resolved_tag.replace(/^.*--v|^v/, ''));
  return v !== null && [...ranges].every((r) => semver.satisfies(v, r));
}

export interface OutdatedInfo {
  identity: string;
  name: string;
  current: string;
  wanted: string;
  latest: string;
  kind: RefKind;
  outdated: boolean;
}

/** Compares a locked direct dependency with the remote state, without installing anything. */
export async function checkOutdated(
  ref: DepRef,
  lock: LockEntry | undefined,
  git: GitOptions,
): Promise<OutdatedInfo | undefined> {
  if (ref.kind !== 'git') return undefined;
  const identity = depIdentity(ref);
  const kind = classifyRef(ref.ref);
  const refs = await lsRemote(repoLocation(ref, git));
  const versions = versionsFromTags(refs.tags.keys(), packageShortName(ref));
  const latestVersion = semver.maxSatisfying([...versions.keys()], '*');
  const latestTag = latestVersion ? versions.get(latestVersion)! : undefined;
  const short = (sha?: string): string => (sha ? sha.slice(0, 7) : '—');
  const current =
    lock?.resolved_tag ??
    (lock?.resolved_ref && !SHA_RE.test(lock.resolved_ref) && LITERAL_TAG_RE.test(lock.resolved_ref)
      ? lock.resolved_ref
      : short(lock?.resolved_commit));

  let wanted = current;
  let outdated = false;
  if (kind === 'semver') {
    const best = semver.maxSatisfying([...versions.keys()], ref.ref!);
    if (best) {
      wanted = versions.get(best)!;
      outdated = refs.tags.get(wanted) !== lock?.resolved_commit;
    }
  } else if (kind === 'none' || (kind === 'literal' && refs.branches.has(ref.ref!))) {
    const head = kind === 'none' ? refs.head : refs.branches.get(ref.ref!);
    wanted = short(head);
    outdated = head !== undefined && head !== lock?.resolved_commit;
  }
  const latest = latestTag ?? wanted;
  return {
    identity,
    name: lock?.name ?? packageShortName(ref),
    current,
    wanted,
    latest,
    kind,
    outdated: outdated || lock === undefined,
  };
}
