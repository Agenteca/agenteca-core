# Journal des modifications

Ce projet suit [Semantic Versioning](https://semver.org/lang/fr/) et le format
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).

## [Non publié]

## [0.1.0] - 2026-11-10

### Ajouté

- Lecture et réécriture de `apm.yml` (OpenAPM v0.1) avec conservation des commentaires, des clés inconnues et des extensions `x-*`.
- Analyse des références de dépendance (forme chaîne et forme objet), normalisation canonique.
- Lecture et écriture de `apm.lock.yaml` : `tree_sha256`, empreintes par fichier, champs inconnus conservés.
- Résolution git : tags SemVer (dialecte node-semver), intersection des plages entre chaînes de dépendances, rejeu du lockfile, mode figé.
- Lecture des paquets : `.apm/`, `SKILL.md` seul, collection `skills/`, plugin Claude, paquet de hooks.
- Adaptateurs Claude Code, Codex, GitHub Copilot et Cursor, en portée projet et utilisateur.
- Déploiement et retrait avec détection des fichiers modifiés à la main ; fusion ciblée des fichiers de configuration partagés (JSON, JSONC, TOML).
- Scan de sécurité (Unicode caché, motifs suspects) et rapport SARIF 2.1.0.
- Lecture et export des marketplaces natifs (Claude Code, Codex, Copilot CLI, Cursor) ; client de registre.
