# @agenteca/core

TypeScript library of Agenteca: it reads AI agent packages from git repositories and deploys them into Claude Code, Codex, GitHub Copilot and Cursor.

It implements the **OpenAPM v0.1** format (`apm.yml`, `apm.lock.yaml`) without depending on the `apm` tool. The `ahub` CLI, the server and the editor extensions all build on it.

> Status: 0.1.0, not yet published on npm. OpenAPM itself is a working draft (0.x): the format may change.

## What it does

| Area | Module | Standard followed |
|---|---|---|
| Manifest | `manifest.ts`, `depref.ts` | OpenAPM §4 |
| Lockfile and hashes | `lockfile.ts`, `hash.ts` | OpenAPM §5 |
| Version resolution | `resolver.ts`, `git.ts` | OpenAPM §7, SemVer (node-semver dialect) |
| Package reading | `package.ts` | OpenAPM §8.1, Agent Skills |
| Per-tool adapters | `adapters/` | OpenAPM target matrix, documentation of each tool |
| Deployment and removal | `deploy.ts`, `merge.ts` | — |
| Security scan | `scan.ts` | SARIF 2.1.0 |
| Marketplaces and registries | `marketplace.ts`, `registry.ts` | Native formats of Claude Code, Codex, Copilot CLI, Cursor |
| Messages in five languages | `i18n.ts`, `locales/` | — |

Conformance, requirement by requirement, is detailed in [CONFORMANCE.md](CONFORMANCE.md).

## Usage

```ts
import { applyInstall, createContext, parseDepString, prepareInstall } from '@agenteca/core';

const ctx = createContext({ cwd: process.cwd() });

// 1. Prepare: resolution, reading, scan, plan. Nothing is written.
const prepared = await prepareInstall(ctx, {
  add: [parseDepString('acme/code-review#^1.0.0')],
  targets: ['claude', 'cursor'],
  initName: 'my-project',
});
console.log(prepared.plan.files, prepared.executables, prepared.findings);

// 2. Apply, once the user has agreed.
await applyInstall(prepared);
```

`prepareInstall` also covers lockfile replay (`{ frozen: true }`), updates (`{ update: 'all' }`) and removal (`{ remove: ['code-review'] }`).

## Where files go

Project scope. In user scope, the same folders under `~` (`~/.copilot/` for Copilot, `~/.claude.json` for Claude Code's MCP servers).

| Tool | Agents | Skills | Commands | Instructions | Hooks | MCP |
|---|---|---|---|---|---|---|
| Claude Code | `.claude/agents/*.md` | `.claude/skills/` | `.claude/commands/*.md` | `.claude/rules/*.md` | `.claude/settings.json` | `.mcp.json` |
| Codex | `.codex/agents/*.toml` | `.agents/skills/` | converted to skills | not deployed | `.codex/hooks.json` | `.codex/config.toml` |
| Copilot | `.github/agents/*.agent.md` | `.agents/skills/` | `.github/prompts/*.prompt.md` | `.github/instructions/` | `.github/hooks/*.json` | `.vscode/mcp.json` + `.github/mcp.json` |
| Cursor | `.cursor/agents/*.md` | `.agents/skills/` | `.cursor/commands/*.md` | `.cursor/rules/*.mdc` | `.cursor/hooks.json` | `.cursor/mcp.json` |

Paths checked against the official documentation of each tool on 10 November 2026.

## Security

An agent is text executed by a model: it is treated as code.

- **Scan before any deployment.** A critical finding (hidden Unicode, downloaded code executed) blocks the installation; overriding it is explicit (`allowUnsafe`).
- **No script is run.** The `scripts:` and `lifecycle:` fields of packages are ignored. Git is called without hooks or prompts, and symbolic links are neutralised.
- **Nothing is overwritten silently.** A file edited by hand, or present without being managed, blocks the operation until the user agrees for that file.
- **Shared configuration files** (`settings.json`, `.mcp.json`, `config.toml`…): only the entries of the package are added, then removed; the rest of the file is never rewritten.
- **Hashes.** `tree_sha256` per repository and SHA-256 per deployed file, checked on replay.
- **Paths.** Any write outside the root, or through a symbolic link, is refused.

The scan rules are listed in `src/scan.ts` (`RULES`). The scan spots known patterns; it does not prove that a package is safe.

## Languages

Messages shown to people (errors, warnings, scan findings) are written in English in the code and translated into French, Spanish, Chinese and Hindi. The language comes from `setLocale()`; `detectLocale()` reads `AHUB_LANG`, then `LC_ALL`, `LC_MESSAGES` and `LANG`. Other packages add their own messages with `registerCatalog()`.

To add or change a message:

1. write it in English, as a literal: `t('package "{0}" is not a folder', [name])`;
2. add its translation to each file of `src/locales/` (keys sorted);
3. run `npm test`: `test/i18n.test.ts` fails if a translation is missing, unused, or has different placeholders.

Error codes, JSON fields and the content of deployed files never depend on the language.

## Known limits (v0.1)

- **Hooks with scripts.** A hook whose command points to a script of the package (`${PLUGIN_ROOT}/…`, `./…`) is skipped with a warning. Only inline commands are deployed.
- **Hooks are not portable.** Event names are translated through a table; an event with no equivalent is skipped with a warning. The data a hook receives differs between tools and is not adapted.
- **Copilot and hook matchers.** Copilot has no per-tool matcher: a hook with a `matcher` is not deployed there, so that it is not widened to every tool.
- **Registry MCP servers.** Only self-defined servers (`registry: false`) are deployed.
- **Agent tools.** Tool names (`tools:`) are specific to each product. They are passed as is to Claude Code and dropped for Codex and Cursor, with a warning in both cases.
- **Codex.** No per-file instructions (Codex only reads `AGENTS.md`); compiling `AGENTS.md` is not implemented.
- **Registry dependencies** (`id:`), `git: parent`, project-specific primitives (`local_deployed_files`): not supported.
- **Full git mirrors.** Each repository is cloned entirely into the cache (`~/.cache/ahub`).

## Points not confirmed by the official documentation

- Claude Code does not document reading `.agents/skills/`: skills go to `.claude/skills/` for it.
- Cursor's user folder for commands (`~/.cursor/commands`) is not documented: commands are not deployed in user scope for Cursor.
- The exact fields of the `url` source of a Codex marketplace are not documented: the Codex export uses `{ source, url, ref }` by analogy with `git-subdir`.
- Reading `.claude-plugin/marketplace.json` from the Codex CLI is not confirmed.

## Environment variables

| Variable | Purpose |
|---|---|
| `AHUB_LANG` | Language of the messages: `en`, `fr`, `es`, `zh`, `hi`. |
| `AHUB_CACHE_DIR` | Folder of the git cache (default: `~/.cache/ahub`). |
| `AHUB_GIT_MIRRORS` | JSON object `{"host/owner/repo": "url or path"}`: replaces the clone URL (company mirrors, tests). |
| `AHUB_HOME` | Replaces the home folder (tests). |
| `AHUB_CONFIG` | Path of the configuration file (default: `~/.config/ahub/config.json`). |
| `AHUB_USER_DIR` | Folder of the user manifest (default: `~/.apm`). |

## Development

```bash
npm install
```

```bash
npm test
```

The tests create real git repositories in temporary folders; no network access. `git` must be installed.

## License

Apache-2.0. The OpenAPM JSON schemas in `vendor/openapm/` are © Microsoft, under Apache-2.0 (see `NOTICE`).
