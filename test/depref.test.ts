import { describe, expect, it } from 'vitest';
import {
  canonicalDepString,
  cloneUrl,
  depIdentity,
  isVirtualFile,
  parseCliPackageArg,
  parseDepEntry,
  parseDepString,
} from '../src/index.js';

describe('références de dépendance (spec §4.3)', () => {
  it('analyse la forme raccourcie', () => {
    const r = parseDepString('acme/tools#v1.2.0');
    expect(r).toMatchObject({
      kind: 'git',
      host: 'github.com',
      owner: 'acme',
      repo: 'tools',
      ref: 'v1.2.0',
      repoUrl: 'github.com/acme/tools',
    });
    expect(cloneUrl(r)).toBe('https://github.com/acme/tools.git');
  });

  it('reconnaît un hôte explicite et un sous-chemin virtuel', () => {
    const r = parseDepString('gitlab.com/acme/std/instructions/security#main');
    expect(r).toMatchObject({
      host: 'gitlab.com',
      owner: 'acme',
      repo: 'std',
      virtualPath: 'instructions/security',
      ref: 'main',
    });
    expect(depIdentity(r)).toBe('gitlab.com/acme/std/instructions/security');
  });

  it('analyse les URL https, ssh et scp', () => {
    expect(parseDepString('https://git.example.com:8443/o/r.git#v1')).toMatchObject({
      form: 'https',
      host: 'git.example.com',
      port: 8443,
      repo: 'r',
      ref: 'v1',
    });
    expect(cloneUrl(parseDepString('ssh://git@git.example.com/o/r'))).toBe(
      'ssh://git@git.example.com/o/r.git',
    );
    expect(cloneUrl(parseDepString('git@github.com:o/r.git'))).toBe('git@github.com:o/r.git');
  });

  it('reconnaît les chemins locaux', () => {
    expect(parseDepString('./packages/x')).toEqual({ kind: 'local', localPath: './packages/x' });
    expect(parseDepString('..\\sibling').localPath).toBe('../sibling');
  });

  it('rejette les chaînes hors grammaire', () => {
    for (const bad of ['', 'justone', 'a//b', 'a/b/../c', 'ftp://h/o/r', 'a/b#']) {
      expect(() => parseDepString(bad), bad).toThrowError(/dépendance invalide/);
    }
  });

  it('normalise en forme canonique en ne retirant que l’hôte par défaut (req-mf-009)', () => {
    expect(canonicalDepString(parseDepString('https://github.com/acme/tools.git#v1'))).toBe('acme/tools#v1');
    expect(canonicalDepString(parseDepString('git@github.com:acme/tools.git'))).toBe('acme/tools');
    expect(canonicalDepString(parseDepString('gitlab.com/acme/tools'))).toBe('gitlab.com/acme/tools');
    expect(canonicalDepString(parseDepString('gitlab.com/acme/tools'), 'gitlab.com')).toBe('acme/tools');
  });

  it('analyse la forme objet et refuse git + id (req-mf-011)', () => {
    const r = parseDepEntry({
      git: 'acme/mono',
      path: 'packages/a',
      ref: '^1.0.0',
      alias: 'a',
      skills: ['x'],
    });
    expect(r).toMatchObject({ virtualPath: 'packages/a', ref: '^1.0.0', alias: 'a', skills: ['x'] });
    expect(() => parseDepEntry({ git: 'a/b', id: 'a/b' })).toThrowError(/mutuellement exclusifs/);
    expect(() => parseDepEntry({ git: 'a/b', alias: '..' })).toThrowError(/alias invalide/);
  });

  it('classe les fichiers virtuels par extension seulement (req-mf-008)', () => {
    expect(isVirtualFile('agents/x.agent.md')).toBe(true);
    expect(isVirtualFile('prompts/x.md')).toBe(false);
  });

  it('interprète les arguments de la CLI (écart de confort @tag)', () => {
    expect(parseCliPackageArg('acme/tools@v1.2.0')).toEqual({ type: 'dep', dep: 'acme/tools#v1.2.0' });
    expect(parseCliPackageArg('acme/tools#v1')).toEqual({ type: 'dep', dep: 'acme/tools#v1' });
    expect(parseCliPackageArg('git@github.com:acme/tools.git')).toEqual({
      type: 'dep',
      dep: 'git@github.com:acme/tools.git',
    });
    expect(parseCliPackageArg('code-review@officiel')).toEqual({
      type: 'catalog',
      name: 'code-review',
      registry: 'officiel',
    });
    expect(parseCliPackageArg('code-review')).toEqual({ type: 'catalog', name: 'code-review' });
    expect(parseCliPackageArg('./local/pkg')).toEqual({ type: 'dep', dep: './local/pkg' });
  });
});
