import { withFrontmatter } from '../yaml.js';
import {
  capabilityDiagnostic,
  convertVarMap,
  convertVars,
  deployableMcp,
  emptyResult,
  selectedSkills,
  skillFiles,
  text,
  toolList,
  translateHooks,
  unparsedFrontmatterDiagnostic,
} from './common.js';
import type { Adapter } from './types.js';

/**
 * Claude Code. Paths checked in the official documentation (10 November 2026):
 * `.claude/{agents,skills,commands,rules}`, hooks in `.claude/settings.json`,
 * MCP servers in `.mcp.json` (project) or `~/.claude.json` (user).
 */
export const claudeAdapter: Adapter = (content, ctx) => {
  const r = emptyResult();
  const base = '.claude';

  r.files.push(...skillFiles(selectedSkills(content, ctx), `${base}/skills`, 'claude'));

  for (const a of content.agents) {
    if (a.frontmatterError) r.diagnostics.push(unparsedFrontmatterDiagnostic(a, 'claude'));
    const fm = a.frontmatter ?? {};
    const tools = toolList(fm.tools);
    const out: Record<string, unknown> = {
      name: a.name,
      description: typeof fm.description === 'string' ? fm.description : `Agent ${a.name}`,
    };
    if (tools) {
      out.tools = tools.join(', ');
      // Tool names are specific to each product: passed as is, reported (req-tg-006).
      r.diagnostics.push(capabilityDiagnostic(a, 'claude', ['tools']));
    }
    if (typeof fm.model === 'string') out.model = fm.model;
    r.files.push({
      path: `${base}/agents/${a.name}.md`,
      bytes: text(withFrontmatter(out, a.body)),
      primitive: 'agent',
      target: 'claude',
    });
  }

  for (const p of content.prompts) {
    const fm = p.frontmatter ?? {};
    const out: Record<string, unknown> = {};
    for (const k of ['description', 'argument-hint', 'allowed-tools', 'model']) {
      if (fm[k] !== undefined) out[k] = fm[k];
    }
    r.files.push({
      path: `${base}/commands/${p.name}.md`,
      bytes: text(withFrontmatter(out, p.body)),
      primitive: 'command',
      target: 'claude',
    });
  }

  for (const i of content.instructions) {
    const applyTo = i.frontmatter?.applyTo;
    const paths =
      typeof applyTo === 'string'
        ? applyTo
            .split(',')
            .map((g) => g.trim())
            .filter(Boolean)
        : Array.isArray(applyTo)
          ? applyTo.map(String)
          : [];
    const out: Record<string, unknown> = paths.length > 0 ? { paths } : {};
    r.files.push({
      path: `${base}/rules/${i.name}.md`,
      bytes: text(withFrontmatter(out, i.body)),
      primitive: 'instruction',
      target: 'claude',
    });
  }

  const th = translateHooks(content.hooks, 'claude', { supportsMatcher: true, passUnknownEvents: true });
  r.diagnostics.push(...th.diagnostics);
  r.executables.push(...th.executables);
  if (th.hooks.length > 0) {
    r.merges.push({
      path: `${base}/settings.json`,
      format: 'json',
      kind: 'hooks',
      target: 'claude',
      entries: th.hooks.map((h) => {
        const handler: Record<string, unknown> = { type: 'command', command: h.command };
        if (h.timeout !== undefined) handler.timeout = h.timeout;
        const group: Record<string, unknown> = h.matcher
          ? { matcher: h.matcher, hooks: [handler] }
          : { hooks: [handler] };
        return { type: 'append' as const, keyPath: ['hooks', h.event], value: group };
      }),
    });
  }

  const mcp = deployableMcp(content.mcp, 'claude');
  r.diagnostics.push(...mcp.diagnostics);
  r.executables.push(...mcp.executables);
  if (mcp.servers.length > 0) {
    r.merges.push({
      path: ctx.scope === 'user' ? '.claude.json' : '.mcp.json',
      format: 'json',
      kind: 'mcp',
      target: 'claude',
      entries: mcp.servers.map((m) => {
        const value: Record<string, unknown> = {};
        if (m.transport === 'stdio') {
          // `type` is optional for Claude Code; it is written to produce the same entry as apm.
          value.type = 'stdio';
          value.command = convertVars(m.command!, 'plain');
          value.args = (m.args ?? []).map((a) => convertVars(a, 'plain'));
          const env = convertVarMap(m.env, 'plain');
          if (env) value.env = env;
        } else {
          value.type = m.transport === 'sse' ? 'sse' : 'http';
          value.url = convertVars(m.url!, 'plain');
          const headers = convertVarMap(m.headers, 'plain');
          if (headers) value.headers = headers;
        }
        return { type: 'key' as const, keyPath: ['mcpServers', m.name], value };
      }),
    });
  }
  return r;
};
