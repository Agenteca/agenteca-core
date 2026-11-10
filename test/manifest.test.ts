import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { ManifestFile, parseDepString, parseYamlSafe } from '../src/index.js';
import { officialSchema } from './helpers.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateManifest = ajv.compile(officialSchema('manifest-v0.1.48.schema.json'));

describe('manifeste apm.yml (spec §4)', () => {
  it('lit un manifeste minimal', () => {
    const m = ManifestFile.parse('name: demo\nversion: 1.0.0\n').manifest;
    expect(m).toMatchObject({ name: 'demo', version: '1.0.0', apm: [], mcp: [] });
  });

  it('garde la version en chaîne même si elle ressemble à un nombre', () => {
    const m = ManifestFile.parse('name: demo\nversion: 1.0\n').manifest;
    expect(m.version).toBe('1.0');
    expect(m.diagnostics.map((d) => d.code)).toContain('VERSION_NOT_SEMVER');
  });

  it('refuse les documents non conformes', () => {
    expect(() => ManifestFile.parse('- a\n- b\n')).toThrowError(/dictionnaire/);
    expect(() => ManifestFile.parse('version: 1.0.0\n')).toThrowError(/name/);
    expect(() => ManifestFile.parse('name: x\n')).toThrowError(/version/);
    expect(() =>
      ManifestFile.parse('name: x\nversion: 1.0.0\ntarget: claude\ntargets: [codex]\n'),
    ).toThrowError(/mutuellement exclusifs/);
    expect(() => ManifestFile.parse('name: x\nversion: 1.0.0\ntargets: [emacs]\n')).toThrowError(
      /cible inconnue/,
    );
  });

  it('applique le sous-ensemble YAML sûr (req-mf-020)', () => {
    expect(() => ManifestFile.parse('name: &a x\nversion: 1.0.0\nauthor: *a\n')).toThrowError(/ancres|alias/);
    expect(() => ManifestFile.parse('name: !custom x\nversion: 1.0.0\n')).toThrowError(/tag/);
    // Pas de coercition octale YAML 1.1.
    expect((parseYamlSafe('mode: 0777\n', 't.yml') as { mode: unknown }).mode).toBe(777);
  });

  it('normalise les alias de cible (vscode → copilot)', () => {
    expect(
      ManifestFile.parse('name: x\nversion: 1.0.0\ntarget: [vscode, claude]\n').manifest.targets,
    ).toEqual(['copilot', 'claude']);
  });

  it('valide les serveurs MCP auto-définis (req-mf-012)', () => {
    const base = 'name: x\nversion: 1.0.0\ndependencies:\n  mcp:\n';
    expect(() => ManifestFile.parse(`${base}    - {name: s, registry: false}\n`)).toThrowError(/transport/);
    expect(() =>
      ManifestFile.parse(`${base}    - {name: s, registry: false, transport: stdio}\n`),
    ).toThrowError(/command/);
    expect(() =>
      ManifestFile.parse(`${base}    - {name: s, registry: false, transport: http}\n`),
    ).toThrowError(/url/);
    expect(() =>
      ManifestFile.parse(`${base}    - {name: s, registry: false, transport: stdio, command: "my bin"}\n`),
    ).toThrowError(/espaces/);
    const ok = ManifestFile.parse(
      `${base}    - {name: s, registry: false, transport: stdio, command: "my bin", args: []}\n`,
    ).manifest;
    expect(ok.mcp[0]).toMatchObject({ name: 's', command: 'my bin', args: [] });
  });

  it('préserve commentaires, clés inconnues et extensions à la réécriture (req-mf-006, req-ext-001)', () => {
    const src = [
      '# en-tête à conserver',
      'name: demo',
      'version: 1.0.0',
      'future_key: {a: 1}',
      'x-vendor-thing: keep',
      'dependencies:',
      '  apm:',
      '    - acme/one#v1 # épinglé',
      '  mcp: []',
      '',
    ].join('\n');
    const mf = ManifestFile.parse(src);
    expect(mf.setApmDependency(parseDepString('https://github.com/acme/two.git#^2.0.0'))).toBe(false);
    const out = mf.toString();
    expect(out).toContain('# en-tête à conserver');
    expect(out).toContain('future_key');
    expect(out).toContain('x-vendor-thing: keep');
    expect(out).toContain('acme/one#v1 # épinglé');
    expect(out).toContain('acme/two#^2.0.0');
    const again = ManifestFile.parse(out);
    expect(again.manifest.apm).toHaveLength(2);
    expect(again.setApmDependency(parseDepString('acme/two#^3.0.0'))).toBe(true);
    expect(again.removeApmDependency('github.com/acme/one')).toBe(true);
    expect(again.toString()).not.toContain('acme/one');
    expect(again.toString()).toContain('acme/two#^3.0.0');
  });

  it('retrouve une dépendance par nom court', () => {
    const mf = ManifestFile.parse(
      'name: x\nversion: 1.0.0\ndependencies:\n  apm:\n    - acme/one\n    - other/two/sub/pkg\n',
    );
    expect(mf.findDependency('one')?.repo).toBe('one');
    expect(mf.findDependency('acme/one')?.repo).toBe('one');
    expect(mf.findDependency('pkg')?.repo).toBe('two');
    expect(mf.findDependency('absent')).toBeUndefined();
  });

  it('produit des manifestes acceptés par le schéma officiel OpenAPM', () => {
    const mf = ManifestFile.create({ name: 'demo', targets: ['claude', 'codex'] });
    mf.setApmDependency(parseDepString('acme/one#^1.0.0'));
    mf.setApmDependency(parseDepString('./local/pkg'));
    const js = parseYamlSafe(mf.toString(), 'apm.yml');
    expect(validateManifest(js), JSON.stringify(validateManifest.errors)).toBe(true);
  });
});
