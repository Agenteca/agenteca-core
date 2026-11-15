import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileOp, MergeOp } from './adapters/types.js';
import { AhubError } from './errors.js';
import { fileHash, sha256Hex, stableStringify } from './hash.js';
import type { MergedEntryRecord, MergedFileRecord } from './lockfile.js';
import type { Target } from './manifest.js';
import { jsonIsEffectivelyEmpty, mergeJson, mergeToml, unmergeJson, unmergeToml } from './merge.js';
import { t } from './i18n.js';

/** Deployment operations produced by the adapters for one package. */
export interface PackageOps {
  identity: string;
  name: string;
  files: FileOp[];
  merges: MergeOp[];
}

/** Previous state of a package, as recorded in the lockfile. */
export interface PriorPackageState {
  identity: string;
  files: Record<string, string>;
  merged: MergedFileRecord[];
}

export interface PlannedFile {
  path: string;
  action: 'create' | 'update' | 'unchanged' | 'conflict';
  /** `modified`: managed file, edited by hand; `unmanaged`: existing file not managed by ahub. */
  reason?: 'modified' | 'unmanaged';
  hash: string;
  size: number;
  owners: string[];
  primitive: string;
  targets: Target[];
}

export interface PlannedRemoval {
  path: string;
  action: 'remove' | 'conflict' | 'missing';
  owner: string;
}

export interface PlannedMerge {
  path: string;
  format: 'json' | 'toml';
  kind: 'mcp' | 'hooks';
  action: 'create' | 'update' | 'unchanged' | 'delete';
  /** Keys added or removed, readable by a human. */
  changes: string[];
  conflicts: string[];
}

export interface PlanConflict {
  path: string;
  reason: 'modified' | 'unmanaged' | 'merge';
  message: string;
}

export interface DeployPlan {
  root: string;
  files: PlannedFile[];
  removals: PlannedRemoval[];
  merges: PlannedMerge[];
  conflicts: PlanConflict[];
}

/** Plan with the contents to write (not serialisable). */
export interface PreparedDeploy {
  plan: DeployPlan;
  contents: Map<string, { bytes: Buffer; executable: boolean }>;
  mergeTexts: Map<string, string | null>;
  /** Per package: what will be recorded in the lockfile once the plan is applied. */
  records: Map<string, { files: Record<string, string>; merged: MergedFileRecord[] }>;
}

/** Checks that a relative path stays inside the root, without going through a symbolic link. */
export async function resolveInside(root: string, rel: string): Promise<string> {
  if (
    !rel ||
    rel.includes('\0') ||
    rel.includes('\\') ||
    path.posix.isAbsolute(rel) ||
    /^[A-Za-z]:/.test(rel)
  ) {
    throw new AhubError('CONFLICT', t('deployment path refused: "{0}"', [rel]));
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new AhubError('CONFLICT', t('deployment path refused: "{0}"', [rel]));
  }
  let current = root;
  for (const seg of segments) {
    current = path.join(current, seg);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) {
        throw new AhubError('CONFLICT', t('"{0}" goes through a symbolic link: write refused', [rel]));
      }
    } catch (e) {
      if (e instanceof AhubError) throw e;
      break; // the rest of the path does not exist yet
    }
  }
  return path.join(root, ...segments);
}

async function readIfExists(file: string): Promise<Buffer | undefined> {
  try {
    const st = await lstat(file);
    if (!st.isFile()) return undefined;
    return await readFile(file);
  } catch {
    return undefined;
  }
}

function describeEntry(e: MergedEntryRecord): string {
  return e.keyPath.join('.');
}

/**
 * Computes what will be written, updated or removed, without touching the disk.
 * Central rule: a file edited by hand, or present without being managed
 * by ahub, is never overwritten or deleted without explicit agreement.
 */
export async function prepareDeploy(
  root: string,
  packages: PackageOps[],
  prior: PriorPackageState[],
): Promise<PreparedDeploy> {
  const plan: DeployPlan = { root, files: [], removals: [], merges: [], conflicts: [] };
  const contents = new Map<string, { bytes: Buffer; executable: boolean }>();
  const mergeTexts = new Map<string, string | null>();
  const records = new Map<string, { files: Record<string, string>; merged: MergedFileRecord[] }>();
  for (const p of packages) records.set(p.identity, { files: {}, merged: [] });

  // Hash recorded for each managed file, across all packages.
  const priorHashes = new Map<string, string>();
  for (const p of prior) for (const [f, h] of Object.entries(p.files)) priorHashes.set(f, h);

  // --- Fichiers entiers -----------------------------------------------------
  const planned = new Map<string, PlannedFile>();
  for (const pkg of packages) {
    for (const op of pkg.files) {
      const hash = fileHash(op.bytes);
      const existing = planned.get(op.path);
      if (existing) {
        if (existing.hash !== hash) {
          throw new AhubError(
            'CONFLICT',
            t('two sources write "{0}" with different contents ({1} and {2})', [
              op.path,
              existing.owners.join(', '),
              pkg.identity,
            ]),
            { path: op.path },
          );
        }
        if (!existing.owners.includes(pkg.identity)) existing.owners.push(pkg.identity);
        if (!existing.targets.includes(op.target)) existing.targets.push(op.target);
        records.get(pkg.identity)!.files[op.path] = hash;
        continue;
      }
      const abs = await resolveInside(root, op.path);
      const onDisk = await readIfExists(abs);
      const file: PlannedFile = {
        path: op.path,
        action: 'create',
        hash,
        size: op.bytes.length,
        owners: [pkg.identity],
        primitive: op.primitive,
        targets: [op.target],
      };
      if (onDisk === undefined && existsSync(abs)) {
        file.action = 'conflict';
        file.reason = 'unmanaged';
      } else if (onDisk !== undefined) {
        const current = fileHash(onDisk);
        const recorded = priorHashes.get(op.path);
        if (current === hash) file.action = 'unchanged';
        else if (recorded !== undefined && current === recorded) file.action = 'update';
        else {
          file.action = 'conflict';
          file.reason = recorded !== undefined ? 'modified' : 'unmanaged';
        }
      }
      planned.set(op.path, file);
      contents.set(op.path, { bytes: op.bytes, executable: op.executable === true });
      records.get(pkg.identity)!.files[op.path] = hash;
    }
  }
  plan.files = [...planned.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const f of plan.files) {
    if (f.action === 'conflict') {
      plan.conflicts.push({
        path: f.path,
        reason: f.reason!,
        message:
          f.reason === 'modified'
            ? t('"{0}" was edited by hand since it was installed', [f.path])
            : t('"{0}" already exists and is not managed by ahub', [f.path]),
      });
    }
  }

  // --- Files to remove: recorded before, absent from the new plan ----------
  const seenRemoval = new Set<string>();
  for (const p of prior) {
    for (const [f, recorded] of Object.entries(p.files)) {
      if (planned.has(f) || seenRemoval.has(f)) continue;
      seenRemoval.add(f);
      const abs = await resolveInside(root, f);
      const onDisk = await readIfExists(abs);
      if (onDisk === undefined) {
        plan.removals.push({ path: f, action: 'missing', owner: p.identity });
      } else if (fileHash(onDisk) === recorded) {
        plan.removals.push({ path: f, action: 'remove', owner: p.identity });
      } else {
        plan.removals.push({ path: f, action: 'conflict', owner: p.identity });
        plan.conflicts.push({
          path: f,
          reason: 'modified',
          message: t('"{0}" was edited by hand: it will not be deleted without agreement', [f]),
        });
      }
    }
  }
  plan.removals.sort((a, b) => (a.path < b.path ? -1 : 1));

  // --- Shared configuration files -------------------------------------------
  const mergePaths = new Set<string>();
  for (const p of prior) for (const m of p.merged) mergePaths.add(m.path);
  for (const p of packages) for (const m of p.merges) mergePaths.add(m.path);

  for (const filePath of [...mergePaths].sort()) {
    const abs = await resolveInside(root, filePath);
    const original = (await readIfExists(abs))?.toString('utf8');
    let text = original;
    const priorRecords = prior.flatMap((p) =>
      p.merged.filter((m) => m.path === filePath).map((m) => ({ identity: p.identity, record: m })),
    );
    const newOps = packages.flatMap((p) =>
      p.merges.filter((m) => m.path === filePath).map((m) => ({ identity: p.identity, op: m })),
    );
    const format = newOps[0]?.op.format ?? priorRecords[0]!.record.format;
    const kind = newOps[0]?.op.kind ?? priorRecords[0]!.record.kind;
    const created = original === undefined || priorRecords.some((r) => r.record.created === true);
    const pm: PlannedMerge = {
      path: filePath,
      format,
      kind,
      action: 'unchanged',
      changes: [],
      conflicts: [],
    };

    // 1. Remove the old entries (they are put back if they are still wanted).
    const keptByIdentity = new Map<string, MergedEntryRecord[]>();
    for (const { identity, record } of priorRecords) {
      if (text === undefined) continue;
      const res =
        format === 'json' ? unmergeJson(text, record.entries) : unmergeToml(text, identity, record.entries);
      text = res.text;
      if (res.kept.length > 0) keptByIdentity.set(identity, res.kept);
    }

    // 2. Add the new entries, package by package.
    const ensured: MergedEntryRecord[] = [];
    for (const { identity, op } of newOps) {
      const res =
        format === 'json'
          ? mergeJson(text, op.entries)
          : mergeToml(
              text,
              identity,
              op.entries,
              priorRecords.find((r) => r.identity === identity)?.record.entries ?? [],
            );
      text = res.text;
      ensured.push(...res.owned.filter((e) => e.type === 'ensure'));
      for (const c of res.conflicts) {
        const message = t('{0}: {1}', [filePath, c.message]);
        pm.conflicts.push(message);
        plan.conflicts.push({ path: filePath, reason: 'merge', message });
      }
      if (res.owned.length > 0) {
        const record: MergedFileRecord = {
          path: filePath,
          format,
          kind,
          target: op.target,
          entries: res.owned,
        };
        if (created) record.created = true;
        records.get(identity)!.merged.push(record);
      }
    }

    // 3. Entries edited by hand and no longer wanted: left in place, reported.
    for (const [identity, kept] of keptByIdentity) {
      const stillWanted = newOps.some((n) => n.identity === identity);
      for (const k of kept) {
        if (stillWanted) continue; // the conflict was already reported when adding
        const message = t('{0}: "{1}" was edited by hand, entry left in place', [filePath, describeEntry(k)]);
        pm.conflicts.push(message);
        plan.conflicts.push({ path: filePath, reason: 'merge', message });
      }
    }

    const before = new Set(
      priorRecords.flatMap((r) =>
        r.record.entries
          .filter((e) => e.type !== 'ensure')
          .map((e) => `${describeEntry(e)}=${stableStringify(e.value)}`),
      ),
    );
    const after = new Set(
      newOps.flatMap(({ identity }) =>
        (records.get(identity)!.merged.find((m) => m.path === filePath)?.entries ?? [])
          .filter((e) => e.type !== 'ensure')
          .map((e) => `${describeEntry(e)}=${stableStringify(e.value)}`),
      ),
    );
    for (const a of after) if (!before.has(a)) pm.changes.push(`+ ${a.split('=')[0]}`);
    for (const b of before) if (!after.has(b)) pm.changes.push(`- ${b.split('=')[0]}`);

    let finalText: string | null = text ?? null;
    if (finalText !== null && created && after.size === 0) {
      const empty =
        format === 'json'
          ? jsonIsEffectivelyEmpty(
              finalText,
              ensured.length > 0 ? ensured : priorRecords.flatMap((r) => r.record.entries),
            )
          : finalText.trim() === '';
      if (empty) finalText = null;
    }
    if (finalText === null) pm.action = original === undefined ? 'unchanged' : 'delete';
    else if (original === undefined) pm.action = 'create';
    else pm.action = finalText === original ? 'unchanged' : 'update';
    mergeTexts.set(filePath, finalText);
    plan.merges.push(pm);
  }

  return { plan, contents, mergeTexts, records };
}

/** Hash of the plan: what the user saw is exactly what will be applied. */
export function planFingerprint(plan: DeployPlan, extra: unknown = null): string {
  return sha256Hex(
    stableStringify({
      files: plan.files.map((f) => [f.path, f.action, f.hash]),
      removals: plan.removals.map((r) => [r.path, r.action]),
      merges: plan.merges.map((m) => [m.path, m.action, m.changes, m.conflicts]),
      extra,
    }),
  );
}

async function writeAtomic(abs: string, bytes: Buffer | string, executable: boolean): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.ahub-tmp-${process.pid}`;
  await writeFile(tmp, bytes);
  if (executable) await chmod(tmp, 0o755);
  await rename(tmp, abs);
}

async function pruneEmptyDirs(root: string, startDir: string): Promise<void> {
  let dir = startDir;
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      if ((await readdir(dir)).length > 0) return;
      await rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

export interface ApplyOptions {
  /** Conflicting paths that the user agrees to overwrite or delete; `all` for every one. */
  overwrite?: Set<string> | 'all';
}

export interface ApplyResult {
  written: string[];
  removed: string[];
  /** Conflicting files left untouched. */
  skipped: string[];
}

/**
 * Applies a prepared plan. Conflicting files not covered by
 * `overwrite` are left untouched and removed from the record of the package.
 */
export async function applyDeploy(prepared: PreparedDeploy, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const { plan, contents, mergeTexts, records } = prepared;
  const allowed = (p: string): boolean =>
    opts.overwrite === 'all' || (opts.overwrite instanceof Set && opts.overwrite.has(p));
  const result: ApplyResult = { written: [], removed: [], skipped: [] };

  for (const f of plan.files) {
    if (f.action === 'unchanged') continue;
    if (f.action === 'conflict' && !allowed(f.path)) {
      result.skipped.push(f.path);
      for (const owner of f.owners) delete records.get(owner)?.files[f.path];
      continue;
    }
    const abs = await resolveInside(plan.root, f.path);
    const c = contents.get(f.path)!;
    await writeAtomic(abs, c.bytes, c.executable);
    result.written.push(f.path);
  }

  for (const r of plan.removals) {
    if (r.action === 'missing') continue;
    if (r.action === 'conflict' && !allowed(r.path)) {
      result.skipped.push(r.path);
      continue;
    }
    const abs = await resolveInside(plan.root, r.path);
    try {
      await unlink(abs);
      result.removed.push(r.path);
    } catch {
      // already gone
    }
    await pruneEmptyDirs(plan.root, path.dirname(abs));
  }

  for (const m of plan.merges) {
    if (m.action === 'unchanged') continue;
    const abs = await resolveInside(plan.root, m.path);
    const text = mergeTexts.get(m.path);
    if (text === null || text === undefined) {
      try {
        await unlink(abs);
        result.removed.push(m.path);
      } catch {
        // already gone
      }
      await pruneEmptyDirs(plan.root, path.dirname(abs));
    } else {
      await writeAtomic(abs, text, false);
      result.written.push(m.path);
    }
  }
  return result;
}
