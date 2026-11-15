# Conformance to OpenAPM v0.1

Specification: <https://microsoft.github.io/apm/specs/openapm-v01/> (working draft, read on 10 November 2026).

**Statement.** `@agenteca/core` 0.1.0 targets the **Producer** and **Consumer** classes on the subset below. It does not claim full conformance: the specification has 131 "MUST" requirements and only those listed here were assessed. The **Governance** (policies) and **Registry** classes are not implemented.

**Verification.** The manifests and lockfiles produced by the tests are validated against the official JSON schemas (`vendor/openapm/manifest-v0.1.48.schema.json`, `lockfile-v0.1.46.schema.json`). Interoperability with the `apm` tool itself is tested in the `agenteca-cli` repository.

## Implementation choices to declare (spec §11.2)

| Topic | Choice |
|---|---|
| Default host (req-mf-019) | `github.com` when `default_host:` is absent. |
| User scope (req-tg-014) | Manifest `~/.apm/apm.yml`, lockfile `~/.apm/apm.lock.yaml`. Supported targets: claude, codex, copilot, cursor. |
| `content_hash` of local packages (§5.6.4) | SHA-256 of the sorted list `path NUL sha256(file)`, limited to primitive files. |
| Git submodules in `tree_sha256` | Mode `160000`, hashed on the commit identifier (case not covered by the specification). |
| Dependency aliases (req-mf-025) | Validated and kept; no effect on placement (no `apm_modules/` folder). |
| `repo_url` of local packages | `_local/<folder>`, as `apm` writes it. The specification only requires it for git, but `apm` 0.35.0 refuses a lockfile whose local entry has none. |
| Identity read from a lockfile | `repo_url` with the host (written form, the one of the specification's examples) or without the host and with a separate `host` (form written by `apm`): both designate the same package. |
| `mcp_target_servers` | Field of the `apm` tool, outside the specification: written so that `apm` recognises the managed MCP servers. |
| Vendor extension | `x-ahub` per lockfile entry: targets, and the ownership register of merged configuration files. |

## Assessed requirements

Legend: ✅ implemented and tested · 🟡 partial · ❌ not implemented.

### Manifest (§4)

| Requirement | Status | Note |
|---|---|---|
| req-mf-001 document is a mapping | ✅ | |
| req-mf-002, 003 `name`, `version` | ✅ | |
| req-mf-004 SemVer version | ✅ | Non-blocking diagnostic. |
| req-mf-005 valid targets | ✅ | |
| req-mf-006 unknown keys kept | ✅ | Comments are kept too. |
| req-mf-007 dependency grammar | ✅ | |
| req-mf-008 virtual packages by extension | ✅ | |
| req-mf-009 canonical form | ✅ | |
| req-mf-010 `git: parent` | ❌ | Rejected with an explicit message. |
| req-mf-011 `git` and `id` exclusive | ✅ | |
| req-mf-012 self-defined MCP servers | ✅ | |
| req-mf-014, 015, req-sc-006 `registries` | ❌ | Block kept, not interpreted. |
| req-mf-016 local paths | 🟡 | Recognised; `../` outside the project is accepted for the root manifest, refused from a remote package. |
| req-mf-019 `default_host` | ✅ | |
| req-mf-020 safe YAML subset | 🟡 | (b), (c), (d) applied. (a): YAML 1.2 "core" schema (typed integers and booleans), `name` and `version` read as strings. |
| req-mf-022 unsatisfied skill subset | ✅ | |
| req-mf-024 `id:` entries never converted | ✅ | `id:` entries cannot be modified. |
| req-mf-025 aliases | 🟡 | See above. |
| req-ext-001 `x-*` extensions | ✅ | |
| req-tg-008 `target` / `targets` exclusive | ✅ | Per-dependency intersection (`targets:` of the entry) applied. |

### Lockfile (§5)

| Requirement | Status | Note |
|---|---|---|
| req-lk-001 structure | ✅ | |
| req-lk-002 version never downgraded | ✅ | |
| req-lk-003 `repo_url` + `resolved_commit` | ✅ | |
| req-lk-004 unknown version refused | ✅ | |
| req-lk-006, 017 frozen installation | 🟡 | Manifest/lockfile divergence and `tree_sha256` checked; an altered deployed file is reported as a conflict, not as an immediate failure. |
| req-lk-008 git-semver fields | ✅ | |
| req-lk-011 undefined fields omitted, unknown ones kept | ✅ | |
| req-lk-012 hashes of deployed files | ✅ | |
| req-lk-013 registry archives | ❌ | |
| req-lk-014 extensions kept | ✅ | |
| req-lk-015 `tree_sha256` | ✅ | |
| req-lk-016 hash envelopes | ✅ | |
| req-lk-019 informative `name` / `version` | ✅ | |
| req-lk-020, 021 per-target reconciliation | 🟡 | Owned files and entries are removed when no longer wanted; no per-target "declared elsewhere" logic. |
| req-lk-022 repository case | ❌ | |
| §5.3 project-specific entry | ❌ | Fields kept, not managed. |

### Resolution (§7)

| Requirement | Status | Note |
|---|---|---|
| req-rs-001 intersection of ranges | ✅ | Fails closed when empty. |
| req-rs-002 tags, annotated tags, highest tag | ✅ | |
| req-rs-003 ranking of references | ✅ | |
| req-rs-007 node-semver dialect | ✅ | npm's `semver` library. |
| §7.5 lockfile replay | ✅ | |
| §7.5.1 mirrors | 🟡 | URL replacement through `AHUB_GIT_MIRRORS`. |
| §7.7 update | 🟡 | Targeted or global; no advanced options. |
| Conflicts between literal references | 🟡 | The reference of the root manifest wins; otherwise failure. `conflict_resolution` is not read. |

### Primitives and targets (§8)

| Requirement | Status | Note |
|---|---|---|
| §8.1 package layouts | ✅ | APM, lone skill, collection, Claude plugin, hooks. Agent Plugins v1 read as a plugin. |
| req-pr-006 `skills` key of `plugin.json` | 🟡 | Declared paths followed; no canonical deduplication. |
| req-tg-002 deployment roots | ✅ | |
| req-tg-003 `.agents/skills/` convergence | ✅ | Option to go back to native paths. |
| req-tg-004 vendor targets | 🟡 | Accepted when read, ignored with a diagnostic. |
| req-tg-006 lossy agent conversion | ✅ | Diagnostic every time. |
| req-tg-007 compilation of instructions | ❌ | No equivalent of `apm compile`. |
| req-tg-009 closed tool vocabulary | ❌ | None of the supported targets has one. |
| req-tg-015 Codex agent | ✅ | |
| Supported targets | — | claude, codex, copilot, cursor. The other canonical targets are refused with a diagnostic. |

### Security (§10)

| Topic | Status | Note |
|---|---|---|
| §10.6 no execution at installation | ✅ | |
| §10.9 path traversal, symbolic links | ✅ | |
| §10.3 token isolation per host | 🟡 | ahub manages no token: it relies on the user's git configuration. |
| §10.13 to 10.15 approval of executables | 🟡 | Hooks and MCP servers listed before confirmation; no persistent approval register. |

## Deliberate deviations

- **Commands for Codex.** The target matrix has no commands for Codex; Agenteca converts them into skills.
- **`@tag` syntax.** Accepted by the CLI only, always rewritten as `#tag` in `apm.yml`.
