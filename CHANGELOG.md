# Changelog

This project follows [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [Unreleased]

## [0.1.0] - 2026-11-10

### Added

- Reading and rewriting `apm.yml` (OpenAPM v0.1), keeping comments, unknown keys and `x-*` extensions.
- Parsing of dependency references (string and object forms), canonical normalisation.
- Reading and writing `apm.lock.yaml`: `tree_sha256`, per-file hashes, unknown fields kept.
- Git resolution: SemVer tags (node-semver dialect), intersection of ranges across dependency chains, lockfile replay, frozen mode.
- Package reading: `.apm/`, lone `SKILL.md`, `skills/` collection, Claude plugin, hooks package.
- Adapters for Claude Code, Codex, GitHub Copilot and Cursor, in project and user scope.
- Deployment and removal with detection of files edited by hand; targeted merge of shared configuration files (JSON, JSONC, TOML).
- Security scan (hidden Unicode, suspicious patterns) and SARIF 2.1.0 report.
- Reading and export of native marketplaces (Claude Code, Codex, Copilot CLI, Cursor); registry client.
- Translation of messages: English source, catalogs for French, Spanish, Chinese and Hindi (`src/i18n.ts`, `src/locales/`).
