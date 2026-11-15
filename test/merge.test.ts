import { parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  jsonIsEffectivelyEmpty,
  mergeJson,
  mergeToml,
  type MergedEntryRecord,
  unmergeJson,
  unmergeToml,
} from '../src/index.js';

const server: MergedEntryRecord = {
  type: 'key',
  keyPath: ['mcpServers', 'demo'],
  value: { command: 'npx', args: ['-y', 'demo'] },
};
const hook: MergedEntryRecord = {
  type: 'append',
  keyPath: ['hooks', 'PreToolUse'],
  value: { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo a' }] },
};

describe('fusion JSON', () => {
  it('creates the document when it does not exist', () => {
    const r = mergeJson(undefined, [server]);
    expect(JSON.parse(r.text)).toEqual({ mcpServers: { demo: server.value } });
    expect(r.owned).toEqual([server]);
    expect(r.conflicts).toEqual([]);
  });

  it('preserves existing content and comments', () => {
    const existing =
      '{\n  // serveurs de l’équipe\n  "mcpServers": {\n    "autre": { "command": "x" }\n  },\n  "theme": "dark"\n}\n';
    const r = mergeJson(existing, [server]);
    expect(r.text).toContain('// serveurs de l’équipe');
    expect(r.text).toContain('"theme": "dark"');
    expect(r.text).toContain('"autre"');
    expect(r.text).toContain('"demo"');
    // Comments and content are kept; the indentation next to the edit may be normalised.
    const back = unmergeJson(r.text, r.owned);
    expect(back.text).toContain('// serveurs de l’équipe');
    expect(parseJsonc(back.text)).toEqual(parseJsonc(existing));
  });

  it('never overwrites an existing key with a different value', () => {
    const existing = '{"mcpServers":{"demo":{"command":"autre"}}}';
    const r = mergeJson(existing, [server]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.reason).toBe('foreign');
    expect(r.owned).toEqual([]);
    expect(JSON.parse(r.text).mcpServers.demo.command).toBe('autre');
  });

  it('adopts an identical value already present', () => {
    const r = mergeJson(JSON.stringify({ mcpServers: { demo: server.value } }), [server]);
    expect(r.conflicts).toEqual([]);
    expect(r.owned).toEqual([server]);
  });

  it('adds to lists without duplicates and removes only its own item', () => {
    const existing = JSON.stringify(
      { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo perso' }] }] } },
      null,
      2,
    );
    const once = mergeJson(existing, [hook]);
    const twice = mergeJson(once.text, [hook]);
    expect(JSON.parse(twice.text).hooks.PreToolUse).toHaveLength(2);
    const back = unmergeJson(twice.text, [hook]);
    expect(JSON.parse(back.text).hooks.PreToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'echo perso' }] },
    ]);
  });

  it('prunes containers that became empty on removal', () => {
    const r = mergeJson(undefined, [server, hook]);
    const back = unmergeJson(r.text, r.owned);
    expect(JSON.parse(back.text)).toEqual({});
  });

  it('leaves in place an entry edited by hand', () => {
    const r = mergeJson(undefined, [server]);
    const edited = r.text.replace('"npx"', '"node"');
    const back = unmergeJson(edited, r.owned);
    expect(back.kept).toEqual([server]);
    expect(JSON.parse(back.text).mcpServers.demo.command).toBe('node');
  });

  it('sets "ensure" keys without removing them', () => {
    const ensure: MergedEntryRecord = { type: 'ensure', keyPath: ['version'], value: 1 };
    const r = mergeJson(undefined, [ensure, hook]);
    expect(JSON.parse(r.text).version).toBe(1);
    const back = unmergeJson(r.text, r.owned);
    expect(JSON.parse(back.text)).toEqual({ version: 1 });
    expect(jsonIsEffectivelyEmpty(back.text, [ensure])).toBe(true);
    expect(jsonIsEffectivelyEmpty('{"version":1,"autre":2}', [ensure])).toBe(false);
  });

  it('laisse intact un fichier illisible', () => {
    const r = mergeJson('{ pas du json', [server]);
    expect(r.text).toBe('{ pas du json');
    expect(r.conflicts[0]!.reason).toBe('unreadable');
  });
});

describe('TOML merge (delimited block)', () => {
  const entry: MergedEntryRecord = {
    type: 'block',
    keyPath: ['mcp_servers', 'demo'],
    value: { command: 'npx', args: ['-y', 'demo'], env: { A: '1' } },
  };

  it('adds a block without rewriting the rest of the file', () => {
    const existing = '# ma config\nmodel = "gpt-5"\n\n[mcp_servers.autre]\ncommand = "x"\n';
    const r = mergeToml(existing, 'github.com/acme/demo', [entry], []);
    expect(r.text.startsWith(existing.trimEnd())).toBe(true);
    const parsed = parseToml(r.text) as any;
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.mcp_servers.autre.command).toBe('x');
    expect(parsed.mcp_servers.demo).toEqual(entry.value);
    const back = unmergeToml(r.text, 'github.com/acme/demo', r.owned);
    expect(back.text).toBe(existing);
  });

  it('refuses to overwrite an existing table outside the block', () => {
    const r = mergeToml('[mcp_servers.demo]\ncommand = "autre"\n', 'id', [entry], []);
    expect(r.conflicts[0]!.reason).toBe('foreign');
    expect(r.owned).toEqual([]);
  });

  it('replaces its own block on update', () => {
    const first = mergeToml(undefined, 'id', [entry], []);
    const next: MergedEntryRecord = { ...entry, value: { command: 'node', args: [] } };
    const second = mergeToml(first.text, 'id', [next], first.owned);
    expect((parseToml(second.text) as any).mcp_servers.demo).toEqual(next.value);
    expect(second.text.match(/>>> ahub/g)).toHaveLength(1);
  });

  it('detects a block edited by hand', () => {
    const first = mergeToml(undefined, 'id', [entry], []);
    const edited = first.text.replace('"npx"', '"node"');
    expect(mergeToml(edited, 'id', [entry], first.owned).conflicts[0]!.reason).toBe('modified');
    expect(unmergeToml(edited, 'id', first.owned).kept).toHaveLength(1);
  });

  it('deletes everything when the file only contained the block', () => {
    const first = mergeToml(undefined, 'id', [entry], []);
    expect(unmergeToml(first.text, 'id', first.owned).text).toBe('');
  });
});
