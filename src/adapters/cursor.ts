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
  translateHooks,
  unparsedFrontmatterDiagnostic,
} from './common.js';
import type { Adapter } from './types.js';
import { t } from '../i18n.js';

/**
 * Cursor. Subagents `.cursor/agents/*.md`, skills `.agents/skills/` (or
 * `.cursor/skills/`), commands `.cursor/commands/*.md`, rules
 * `.cursor/rules/*.mdc`, hooks `.cursor/hooks.json`, MCP `.cursor/mcp.json`.
 */
export const cursorAdapter: Adapter = (content, ctx) => {
  const r = emptyResult();
  const user = ctx.scope === 'user';
  const skillsDir = ctx.legacySkillPaths ? '.cursor/skills' : '.agents/skills';
  r.files.push(...skillFiles(selectedSkills(content, ctx), skillsDir, 'cursor'));

  for (const a of content.agents) {
    if (a.frontmatterError) r.diagnostics.push(unparsedFrontmatterDiagnostic(a, 'cursor'));
    const fm = a.frontmatter ?? {};
    const out: Record<string, unknown> = {
      name: a.name,
      description: typeof fm.description === 'string' ? fm.description : `Agent ${a.name}`,
    };
    if (typeof fm.model === 'string') out.model = fm.model;
    if (fm.tools !== undefined) r.diagnostics.push(capabilityDiagnostic(a, 'cursor', ['tools']));
    r.files.push({
      path: `.cursor/agents/${a.name}.md`,
      bytes: text(withFrontmatter(out, a.body)),
      primitive: 'agent',
      target: 'cursor',
    });
  }

  for (const p of content.prompts) {
    if (user) {
      r.diagnostics.push({
        code: 'COMMAND_USER_SCOPE_UNCONFIRMED',
        message: t(
          'command "{0}" → cursor: Cursor does not document a user folder for commands; not deployed.',
          [p.name],
        ),
        path: p.sourcePath,
      });
      continue;
    }
    const out: Record<string, unknown> = {};
    if (typeof p.frontmatter?.description === 'string') out.description = p.frontmatter.description;
    r.files.push({
      path: `.cursor/commands/${p.name}.md`,
      bytes: text(withFrontmatter(out, p.body)),
      primitive: 'command',
      target: 'cursor',
    });
  }

  for (const i of content.instructions) {
    if (user) {
      r.diagnostics.push({
        code: 'INSTRUCTION_USER_SCOPE_UNSUPPORTED',
        message: t(
          'instruction "{0}" → cursor: Cursor user rules are managed in its interface; not deployed.',
          [i.name],
        ),
        path: i.sourcePath,
      });
      continue;
    }
    const applyTo = i.frontmatter?.applyTo;
    const globs =
      typeof applyTo === 'string' ? applyTo : Array.isArray(applyTo) ? applyTo.join(',') : undefined;
    const out: Record<string, unknown> = {};
    if (typeof i.frontmatter?.description === 'string') out.description = i.frontmatter.description;
    if (globs) out.globs = globs;
    out.alwaysApply = !globs;
    r.files.push({
      path: `.cursor/rules/${i.name}.mdc`,
      bytes: text(withFrontmatter(out, i.body)),
      primitive: 'instruction',
      target: 'cursor',
    });
  }

  const th = translateHooks(content.hooks, 'cursor', { supportsMatcher: true });
  r.diagnostics.push(...th.diagnostics);
  r.executables.push(...th.executables);
  if (th.hooks.length > 0) {
    r.merges.push({
      path: '.cursor/hooks.json',
      format: 'json',
      kind: 'hooks',
      target: 'cursor',
      entries: [
        { type: 'ensure' as const, keyPath: ['version'], value: 1 },
        ...th.hooks.map((h) => {
          const value: Record<string, unknown> = { command: h.command, type: 'command' };
          if (h.timeout !== undefined) value.timeout = h.timeout;
          if (h.matcher) value.matcher = h.matcher;
          return { type: 'append' as const, keyPath: ['hooks', h.event], value };
        }),
      ],
    });
  }

  const mcp = deployableMcp(content.mcp, 'cursor');
  r.diagnostics.push(...mcp.diagnostics);
  r.executables.push(...mcp.executables);
  if (mcp.servers.length > 0) {
    r.merges.push({
      path: '.cursor/mcp.json',
      format: 'json',
      kind: 'mcp',
      target: 'cursor',
      entries: mcp.servers.map((m) => {
        const value: Record<string, unknown> = {};
        if (m.transport === 'stdio') {
          value.command = convertVars(m.command!, 'env-prefixed');
          value.args = (m.args ?? []).map((a) => convertVars(a, 'env-prefixed'));
          const env = convertVarMap(m.env, 'env-prefixed');
          if (env) value.env = env;
        } else {
          value.url = convertVars(m.url!, 'env-prefixed');
          const headers = convertVarMap(m.headers, 'env-prefixed');
          if (headers) value.headers = headers;
        }
        return { type: 'key' as const, keyPath: ['mcpServers', m.name], value };
      }),
    });
  }
  return r;
};
