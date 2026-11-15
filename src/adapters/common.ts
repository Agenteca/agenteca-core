import type { Diagnostic } from '../errors.js';
import type { McpDependency, Target } from '../manifest.js';
import type { HookGroup, HookPrimitive, PackageContent, SkillPrimitive, TextPrimitive } from '../package.js';
import type { AdapterContext, AdapterResult, ExecutableNotice, FileOp } from './types.js';
import { t } from '../i18n.js';

export function emptyResult(): AdapterResult {
  return { files: [], merges: [], executables: [], diagnostics: [] };
}

export function text(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

/** Skills kept, applying the `skills:` subset if any. */
export function selectedSkills(content: PackageContent, ctx: AdapterContext): SkillPrimitive[] {
  if (!ctx.skillSubset || ctx.skillSubset.length === 0) return content.skills;
  return content.skills.filter((s) => ctx.skillSubset!.includes(s.name));
}

export function skillFiles(skills: SkillPrimitive[], baseDir: string, target: Target): FileOp[] {
  const out: FileOp[] = [];
  for (const s of skills) {
    for (const f of s.files) {
      const op: FileOp = {
        path: `${baseDir}/${s.name}/${f.relPath}`,
        bytes: f.bytes,
        primitive: 'skill',
        target,
      };
      if (f.executable) op.executable = true;
      out.push(op);
    }
  }
  return out;
}

export function toolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return undefined;
}

/**
 * Diagnostic required by req-tg-006 when a capability restriction declared
 * by the source agent cannot be reproduced exactly.
 */
export function capabilityDiagnostic(agent: TextPrimitive, target: Target, dropped: string[]): Diagnostic {
  return {
    code: 'AGENT_CAPABILITY_NOT_PRESERVED',
    message: t(
      'agent "{0}" → {1}: the fields {2} are not reproduced exactly; the generated agent may have broader access than declared.',
      [agent.name, target, dropped.map((d) => `"${d}"`).join(', ')],
    ),
    path: agent.sourcePath,
  };
}

export function unparsedFrontmatterDiagnostic(agent: TextPrimitive, target: Target): Diagnostic {
  return {
    code: 'AGENT_CAPABILITY_UNVERIFIED',
    message: t('agent "{0}" → {1}: unreadable front matter, capability restrictions could not be verified.', [
      agent.name,
      target,
    ]),
    path: agent.sourcePath,
  };
}

/** Table of hook events: canonical name (Claude form) → native name per target. */
const HOOK_EVENTS: Record<string, Record<Target, string | null>> = {
  SessionStart: {
    claude: 'SessionStart',
    codex: 'SessionStart',
    copilot: 'sessionStart',
    cursor: 'sessionStart',
  },
  SessionEnd: { claude: 'SessionEnd', codex: 'SessionEnd', copilot: 'sessionEnd', cursor: 'sessionEnd' },
  UserPromptSubmit: {
    claude: 'UserPromptSubmit',
    codex: 'UserPromptSubmit',
    copilot: 'userPromptSubmitted',
    cursor: 'beforeSubmitPrompt',
  },
  PreToolUse: { claude: 'PreToolUse', codex: 'PreToolUse', copilot: 'preToolUse', cursor: 'preToolUse' },
  PostToolUse: { claude: 'PostToolUse', codex: 'PostToolUse', copilot: 'postToolUse', cursor: 'postToolUse' },
  Stop: { claude: 'Stop', codex: 'Stop', copilot: 'agentStop', cursor: 'stop' },
  SubagentStart: {
    claude: 'SubagentStart',
    codex: 'SubagentStart',
    copilot: 'subagentStart',
    cursor: 'subagentStart',
  },
  SubagentStop: {
    claude: 'SubagentStop',
    codex: 'SubagentStop',
    copilot: 'subagentStop',
    cursor: 'subagentStop',
  },
  PreCompact: { claude: 'PreCompact', codex: 'PreCompact', copilot: 'preCompact', cursor: 'preCompact' },
};

const HOOK_ALIASES: Record<string, string> = {
  sessionstart: 'SessionStart',
  sessionend: 'SessionEnd',
  userpromptsubmit: 'UserPromptSubmit',
  userpromptsubmitted: 'UserPromptSubmit',
  beforesubmitprompt: 'UserPromptSubmit',
  pretooluse: 'PreToolUse',
  posttooluse: 'PostToolUse',
  agentstop: 'Stop',
  subagentstart: 'SubagentStart',
  subagentstop: 'SubagentStop',
  precompact: 'PreCompact',
};

function canonicalEvent(source: string): string | undefined {
  if (source in HOOK_EVENTS) return source;
  if (source === 'stop') return undefined; // lowercase "stop" is native nowhere except Cursor: ambiguous, not guessed
  return HOOK_ALIASES[source.toLowerCase()];
}

export interface TranslatedHook {
  hookName: string;
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

/**
 * Translates the hooks of a package for a target. Anything that has no
 * safe equivalent is skipped with a diagnostic, never guessed.
 */
export function translateHooks(
  hooks: HookPrimitive[],
  target: Target,
  opts: { supportsMatcher: boolean; passUnknownEvents?: boolean },
): { hooks: TranslatedHook[]; diagnostics: Diagnostic[]; executables: ExecutableNotice[] } {
  const out: TranslatedHook[] = [];
  const diagnostics: Diagnostic[] = [];
  const executables: ExecutableNotice[] = [];
  const skip = (h: HookPrimitive, code: string, message: string): void => {
    diagnostics.push({
      code,
      message: t('hook "{0}" → {1}: {2}', [h.name, target, message]),
      path: h.sourcePath,
    });
  };
  for (const h of hooks) {
    for (const [sourceEvent, groups] of Object.entries(h.events)) {
      const canonical = canonicalEvent(sourceEvent);
      let event: string | null | undefined = canonical ? HOOK_EVENTS[canonical]![target] : undefined;
      if (!event && opts.passUnknownEvents && /^[A-Z][A-Za-z]+$/.test(sourceEvent)) event = sourceEvent;
      if (!event) {
        skip(h, 'HOOK_EVENT_UNSUPPORTED', t('event "{0}" has no equivalent, skipped', [sourceEvent]));
        continue;
      }
      for (const group of groups as HookGroup[]) {
        if (group.matcher && !opts.supportsMatcher) {
          skip(
            h,
            'HOOK_MATCHER_UNSUPPORTED',
            t(
              'the matcher "{0}" does not exist on this target; hook skipped so that it is not widened to every tool',
              [group.matcher],
            ),
          );
          continue;
        }
        for (const handler of group.hooks) {
          const type = handler.type ?? 'command';
          if (type !== 'command' || typeof handler.command !== 'string' || !handler.command.trim()) {
            skip(
              h,
              'HOOK_TYPE_UNSUPPORTED',
              t('handler of type "{0}" is not supported, skipped', [String(type)]),
            );
            continue;
          }
          const command = handler.command;
          if (/\$\{?[A-Z_]*PLUGIN_ROOT\}?/.test(command) || /(^|\s|["'])\.\.?\//.test(command)) {
            skip(
              h,
              'HOOK_SCRIPT_BUNDLE_UNSUPPORTED',
              t(
                'the command refers to a script in the package; deploying hook scripts is not supported in v0.1, hook skipped',
              ),
            );
            continue;
          }
          const translated: TranslatedHook = { hookName: h.name, event, command };
          if (group.matcher) translated.matcher = group.matcher;
          if (typeof handler.timeout === 'number') translated.timeout = handler.timeout;
          out.push(translated);
          executables.push({ kind: 'hook', target, name: h.name, detail: event, command });
        }
      }
    }
  }
  return { hooks: out, diagnostics, executables };
}

export type VarStyle = 'plain' | 'env-prefixed';

/** Converts `${VAR}` / `${env:VAR}` variable references to the style of the target. */
export function convertVars(value: string, style: VarStyle): string {
  if (style === 'plain') return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '${env:$1}');
}

export function convertVarMap(
  map: Record<string, string> | undefined,
  style: VarStyle,
): Record<string, string> | undefined {
  if (!map || Object.keys(map).length === 0) return undefined;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, convertVars(v, style)]));
}

/** Deployable MCP servers: only self-defined servers are, in v0.1. */
export function deployableMcp(
  mcp: McpDependency[],
  target: Target,
): { servers: McpDependency[]; diagnostics: Diagnostic[]; executables: ExecutableNotice[] } {
  const servers: McpDependency[] = [];
  const diagnostics: Diagnostic[] = [];
  const executables: ExecutableNotice[] = [];
  for (const m of mcp) {
    if (m.registry !== false) {
      diagnostics.push({
        code: 'MCP_REGISTRY_UNSUPPORTED',
        message: t(
          'MCP server "{0}" → {1}: resolution through an MCP registry is not supported in v0.1; declare it with "registry: false".',
          [m.name, target],
        ),
      });
      continue;
    }
    const usesInput = [
      m.command,
      m.url,
      ...(m.args ?? []),
      ...Object.values(m.env ?? {}),
      ...Object.values(m.headers ?? {}),
    ].some((v) => typeof v === 'string' && v.includes('${input:'));
    if (usesInput && target !== 'copilot') {
      diagnostics.push({
        code: 'MCP_INPUT_UNSUPPORTED',
        message: t(
          'MCP server "{0}" → {1}: ${input:…} variables only exist in VS Code; value passed as is.',
          [m.name, target],
        ),
      });
    }
    servers.push(m);
    executables.push({
      kind: 'mcp',
      target,
      name: m.name,
      detail: m.transport ?? 'stdio',
      command: m.transport === 'stdio' ? [m.command, ...(m.args ?? [])].join(' ') : (m.url ?? ''),
    });
  }
  return { servers, diagnostics, executables };
}

export function isRemote(m: McpDependency): boolean {
  return m.transport !== 'stdio';
}
