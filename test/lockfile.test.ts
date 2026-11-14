import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  canonicalContent,
  canonicalTreeHash,
  entryIdentity,
  fileHash,
  parseLockfile,
  parseYamlSafe,
  serializeLockfile,
  sha256Hex,
} from '../src/index.js';
import { officialSchema } from './helpers.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateLock = ajv.compile(officialSchema('lockfile-v0.1.46.schema.json'));
const SHA = 'a1b2c3d4e5f6789012345678901234567890abcd';
const H = `sha256:${'0'.repeat(64)}`;

describe('lockfile apm.lock.yaml (spec §5)', () => {
  it('trie les entrées, omet les champs non définis et valide le schéma officiel', () => {
    const text = serializeLockfile({
      lockfile_version: '1',
      dependencies: [
        {
          repo_url: 'github.com/z/z',
          resolved_commit: SHA,
          tree_sha256: H,
          depth: 1,
          deployed_files: ['b', 'a'],
          deployed_file_hashes: { b: H, a: H },
        },
        {
          repo_url: 'github.com/a/a',
          resolved_commit: SHA,
          tree_sha256: H,
          depth: 1,
          virtual_path: 'sub',
          is_virtual: true,
          resolved_by: undefined as unknown as string,
        },
      ],
    });
    const data = parseYamlSafe(text, 'apm.lock.yaml') as {
      dependencies: Array<Record<string, unknown>>;
      lockfile_version: unknown;
    };
    expect(data.lockfile_version).toBe('1');
    expect(data.dependencies.map((d) => d.repo_url)).toEqual(['github.com/a/a', 'github.com/z/z']);
    expect(data.dependencies[1]!.deployed_files).toEqual(['a', 'b']);
    expect(text).not.toContain('null');
    expect(text).not.toContain('resolved_by');
    expect(validateLock(data), JSON.stringify(validateLock.errors)).toBe(true);
  });

  it('conserve les champs inconnus et les extensions x-* (req-lk-011, req-lk-014)', () => {
    const src = [
      'lockfile_version: "1"',
      'x-top: {keep: true}',
      'future_top: 3',
      'dependencies:',
      '  - repo_url: github.com/a/a',
      `    resolved_commit: "${SHA}"`,
      '    future_field: kept',
      '    x-vendor: {n: 1}',
      '',
    ].join('\n');
    const lock = parseLockfile(src);
    const out = serializeLockfile(lock);
    expect(out).toContain('future_field: kept');
    expect(out).toContain('x-vendor');
    expect(out).toContain('x-top');
    expect(out).toContain('future_top: 3');
  });

  it('lit l’identité d’une entrée écrite par apm (hôte à part) comme la sienne', () => {
    expect(entryIdentity({ repo_url: 'github.com/acme/tools' })).toBe('github.com/acme/tools');
    expect(entryIdentity({ repo_url: 'acme/tools', host: 'github.com', virtual_path: 'pkg/a' })).toBe(
      'github.com/acme/tools/pkg/a',
    );
    expect(entryIdentity({ repo_url: 'acme/tools' })).toBe('github.com/acme/tools');
    expect(entryIdentity({ repo_url: 'acme/tools', host: 'gitlab.com' })).toBe('gitlab.com/acme/tools');
    expect(entryIdentity({ repo_url: '_local/pkg', source: 'local', local_path: './pkg' })).toBe(
      'local:./pkg',
    );
  });

  it('refuse une version inconnue en proposant les deux issues (req-lk-004)', () => {
    expect(() => parseLockfile('lockfile_version: "9"\ndependencies: []\n')).toThrowError(
      /Mettez à jour ahub, ou régénérez/,
    );
  });

  it('ne rétrograde jamais la version 2 (req-lk-002)', () => {
    const previous = parseLockfile('lockfile_version: "2"\ndependencies: []\n');
    expect(serializeLockfile({ lockfile_version: '1', dependencies: [] }, previous)).toContain(
      'lockfile_version: "2"',
    );
  });

  it('accepte l’hexadécimal nu en lecture et écrit l’enveloppe (req-lk-016)', () => {
    const lock = parseLockfile(
      `lockfile_version: "1"\ndependencies:\n  - repo_url: github.com/a/a\n    resolved_commit: "${SHA}"\n    tree_sha256: "${'f'.repeat(64)}"\n`,
    );
    expect(lock.dependencies[0]!.tree_sha256).toBe(`sha256:${'f'.repeat(64)}`);
  });
});

describe('empreintes', () => {
  it('normalise CRLF en LF pour le texte, pas le CR seul, pas le binaire (req-lk-012)', () => {
    expect(fileHash(Buffer.from('a\r\nb\r\n'))).toBe(fileHash(Buffer.from('a\nb\n')));
    expect(fileHash(Buffer.from('a\rb'))).not.toBe(fileHash(Buffer.from('a\nb')));
    const binary = Buffer.from([0, 13, 10, 1]);
    expect(canonicalContent(binary)).toEqual(binary);
    expect(fileHash(Buffer.from('x'))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('calcule l’arbre canonique trié octet par octet (spec §5.6.4)', () => {
    const blob = sha256Hex('contenu');
    const expected = sha256Hex(`100644 a.md ${blob}\n100755 b.sh ${blob}\n`);
    expect(
      canonicalTreeHash([
        { mode: '100755', name: 'b.sh', sha256: blob },
        { mode: '100644', name: 'a.md', sha256: blob },
      ]),
    ).toBe(expected);
  });
});
