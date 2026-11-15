import { isUtf8 } from 'node:buffer';
import { sha256Hex } from './hash.js';
import { msg, t } from './i18n.js';

export type Severity = 'critical' | 'warning' | 'info';

export interface ScanRule {
  id: string;
  name: string;
  severity: Severity;
  description: string;
  help: string;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  path: string;
  line: number;
  column: number;
  message: string;
}

export interface ScanInput {
  path: string;
  bytes: Buffer;
}

/**
 * Rules of the scan. The classes of code points follow the state of the art
 * (APM's scanner, Cisco skill-scanner, "Trojan Source"); AHUB-U007
 * (homoglyphs) and the AHUB-P* rules are specific to Agenteca.
 */
export const RULES: ScanRule[] = [
  {
    id: 'AHUB-U001',
    name: 'unicode-tags',
    severity: 'critical',
    description: msg(
      'Characters from the Unicode "Tags" block (U+E0000–E007F), invisible to people and readable by a model.',
    ),
    help: msg('Remove these characters: they are used to hide instructions ("ASCII smuggling").'),
  },
  {
    id: 'AHUB-U002',
    name: 'bidi-control',
    severity: 'critical',
    description: msg('Bidirectional controls (U+202A–202E, U+2066–2069) that reorder the displayed text.'),
    help: msg(
      'Remove these characters: the text the model reads differs from the text displayed ("Trojan Source").',
    ),
  },
  {
    id: 'AHUB-U003',
    name: 'variation-selector-supplement',
    severity: 'critical',
    description: msg('Supplementary variation selectors (U+E0100–E01EF), which can encode hidden data.'),
    help: msg('Remove these characters.'),
  },
  {
    id: 'AHUB-U004',
    name: 'invalid-encoding',
    severity: 'critical',
    description: msg('Text file whose UTF-8 encoding is invalid (lone surrogates, truncated sequences).'),
    help: msg('Save the file again as valid UTF-8.'),
  },
  {
    id: 'AHUB-U005',
    name: 'zero-width',
    severity: 'warning',
    description: msg(
      'Invisible characters (zero width, bidi marks, invisible operators, soft hyphen, BOM in the middle of a file).',
    ),
    help: msg('Check that they are legitimate (for example in Arabic or Hindi text); otherwise remove them.'),
  },
  {
    id: 'AHUB-U006',
    name: 'unusual-whitespace',
    severity: 'info',
    description: msg('Unusual whitespace (no-break, em, ideographic, line separators).'),
    help: msg('Usually harmless; check it when it appears in a command or a name.'),
  },
  {
    id: 'AHUB-U007',
    name: 'mixed-script-confusable',
    severity: 'warning',
    description: msg('Word mixing Latin letters with look-alike Cyrillic or Greek letters (homoglyphs).'),
    help: msg('Check the word: it may imitate the name of a command, a file or a domain.'),
  },
  {
    id: 'AHUB-P001',
    name: 'pipe-to-shell',
    severity: 'critical',
    description: msg('Download executed directly by an interpreter (curl … | sh).'),
    help: msg('An agent package must not make anyone run downloaded code. Refuse it, or examine the URL.'),
  },
  {
    id: 'AHUB-P002',
    name: 'encoded-execution',
    severity: 'critical',
    description: msg('Content that is encoded and then executed (base64 -d | sh, eval(atob(…))).'),
    help: msg('Decode and read the content before installing anything.'),
  },
  {
    id: 'AHUB-P003',
    name: 'instruction-override',
    severity: 'warning',
    description: msg('Wording that asks to ignore earlier instructions or to hide an action from the user.'),
    help: msg('Read the passage again: this is the typical shape of a prompt injection.'),
  },
  {
    id: 'AHUB-P004',
    name: 'credential-access',
    severity: 'warning',
    description: msg('Reference to local secrets (SSH keys, cloud credentials, .env files, tokens).'),
    help: msg('Check that the agent has a legitimate reason to read these files.'),
  },
  {
    id: 'AHUB-P005',
    name: 'hidden-comment-instruction',
    severity: 'warning',
    description: msg('HTML comment (invisible in rendered Markdown) containing instructions.'),
    help: msg('Read the comment: the model sees it, the reader does not.'),
  },
  {
    id: 'AHUB-P006',
    name: 'exfiltration',
    severity: 'warning',
    description: msg(
      'Data sent to the outside (outgoing request carrying a file or an environment variable, URL to an IP address).',
    ),
    help: msg('Check the destination and the data being sent.'),
  },
];

const RULE = new Map(RULES.map((r) => [r.id, r]));

function codepointRule(cp: number, atStart: boolean): string | undefined {
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'AHUB-U001';
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 'AHUB-U002';
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 'AHUB-U003';
  if (cp === 0xfeff) return atStart ? undefined : 'AHUB-U005';
  if (
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0x061c ||
    cp === 0x2060 ||
    (cp >= 0x2061 && cp <= 0x2064) ||
    cp === 0x00ad ||
    (cp >= 0x206a && cp <= 0x206f) ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    cp === 0x180e ||
    (cp >= 0xfe00 && cp <= 0xfe0e)
  ) {
    return 'AHUB-U005';
  }
  if (
    cp === 0x00a0 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000 ||
    cp === 0x2028 ||
    cp === 0x2029
  ) {
    return 'AHUB-U006';
  }
  return undefined;
}

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

// Cyrillic and Greek letters that can be confused with Latin letters.
const CONFUSABLE = /[аеорсухіјһАВЕКМНОРСТХοανρΑΒΕΗΙΚΜΝΟΡΤΧ]/;
const LATIN = /[A-Za-z]/;
const WORD = /[\p{L}\p{N}_.-]+/gu;

interface PatternRule {
  id: string;
  re: RegExp;
}

const PATTERNS: PatternRule[] = [
  { id: 'AHUB-P001', re: /\b(?:curl|wget|fetch)\b[^\n|;]{0,300}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i },
  { id: 'AHUB-P001', re: /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n]{0,300}\|\s*iex\b/i },
  { id: 'AHUB-P001', re: /\b(?:ba|z)?sh\s+(?:-c\s+)?["']?\$\(\s*(?:curl|wget)\b/i },
  { id: 'AHUB-P002', re: /base64\s+(?:-d|--decode|-D)\b[^\n]{0,120}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i },
  { id: 'AHUB-P002', re: /\beval\s*\(\s*(?:atob|Buffer\.from)\s*\(/i },
  { id: 'AHUB-P002', re: /\bexec\s*\(\s*(?:base64\.b64decode|bytes\.fromhex|codecs\.decode)\s*\(/i },
  {
    id: 'AHUB-P003',
    re: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|messages?)/i,
  },
  {
    id: 'AHUB-P003',
    re: /\b(?:ignore[zr]?|oublie[zr]?)\s+(?:toutes\s+)?(?:les\s+)?(?:instructions?|consignes?|règles?)\s+(?:précédentes?|ci-dessus|antérieures?|système)/i,
  },
  {
    id: 'AHUB-P003',
    re: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention\s+(?:this\s+)?to|reveal\s+(?:this\s+)?to|show)\s+(?:the\s+)?user\b/i,
  },
  {
    id: 'AHUB-P003',
    re: /\bne\s+(?:le\s+)?(?:dis|dites|révèle[sz]?|mentionne[sz]?)\s+(?:pas|jamais)\s+(?:cela\s+)?à\s+l['’]utilisateur/i,
  },
  {
    id: 'AHUB-P004',
    re: /(?:~|\$HOME|\/home\/[\w.-]+|\/Users\/[\w.-]+)\/\.(?:ssh|aws|gnupg|kube|docker|netrc|npmrc|config\/gcloud)\b/,
  },
  {
    id: 'AHUB-P004',
    re: /\bid_(?:rsa|ed25519|ecdsa)\b|\b(?:cat|read|print|send|upload|type)\b[^\n]{0,60}\.env\b/i,
  },
  {
    id: 'AHUB-P004',
    re: /\b(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|GH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|NPM_TOKEN)\b[^\n]{0,80}\b(?:curl|wget|http|send|post|upload)/i,
  },
  {
    id: 'AHUB-P006',
    re: /\b(?:curl|wget)\b[^\n]{0,200}(?:-d|--data(?:-binary|-raw)?|-F|--form|--upload-file|-T)\s+["']?[@$]/i,
  },
  { id: 'AHUB-P006', re: /\bhttps?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\//i },
];

const HIDDEN_COMMENT = /<!--([\s\S]*?)-->/g;
const IMPERATIVE =
  /\b(?:you\s+(?:must|should|are|will)|always|never|ignore|execute|run\s+the|send|do\s+not|tu\s+dois|vous\s+devez|toujours|jamais|exécute[zr]?|envoie[zr]?)\b/i;

function isProbablyText(bytes: Buffer): boolean {
  return !bytes.subarray(0, 8000).includes(0);
}

/** Scans a file. Binary files are not inspected. */
export function scanFile(input: ScanInput): Finding[] {
  const findings: Finding[] = [];
  const { path: filePath, bytes } = input;
  if (!isProbablyText(bytes)) return findings;
  const push = (ruleId: string, line: number, column: number, message: string): void => {
    findings.push({ ruleId, severity: RULE.get(ruleId)!.severity, path: filePath, line, column, message });
  };

  if (!isUtf8(bytes)) {
    push('AHUB-U004', 1, 1, t('Invalid UTF-8 encoding: what a model actually reads is unpredictable.'));
  }
  const textContent = bytes.toString('utf8');
  const lines = textContent.split(/\r\n|\n|\r/);

  // A single finding per rule and per line, to stay readable.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const seen = new Set<string>();
    let col = 0;
    for (const ch of line) {
      col += 1;
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80) continue;
      const ruleId = codepointRule(cp, i === 0 && col === 1);
      if (ruleId && !seen.has(ruleId)) {
        seen.add(ruleId);
        const count = [...line].filter((c) => codepointRule(c.codePointAt(0)!, false) === ruleId).length;
        push(
          ruleId,
          i + 1,
          col,
          count > 1
            ? t('{0} First character: {1} ({2} on the line).', [
                t(RULE.get(ruleId)!.description),
                hex(cp),
                count,
              ])
            : t('{0} First character: {1}.', [t(RULE.get(ruleId)!.description), hex(cp)]),
        );
      }
    }
    if (CONFUSABLE.test(line)) {
      for (const m of line.matchAll(WORD)) {
        const word = m[0];
        if (LATIN.test(word) && CONFUSABLE.test(word)) {
          push(
            'AHUB-U007',
            i + 1,
            (m.index ?? 0) + 1,
            t('The word "{0}" mixes Latin letters with Cyrillic or Greek homoglyphs.', [word]),
          );
          break;
        }
      }
    }
    const matched = new Set<string>();
    for (const p of PATTERNS) {
      if (matched.has(p.id)) continue;
      const m = p.re.exec(line);
      if (m) {
        matched.add(p.id);
        push(
          p.id,
          i + 1,
          m.index + 1,
          t('{0} Excerpt: "{1}"', [t(RULE.get(p.id)!.description), m[0].slice(0, 120)]),
        );
      }
    }
  }

  if (/\.(md|mdc|markdown)$/i.test(filePath)) {
    for (const m of textContent.matchAll(HIDDEN_COMMENT)) {
      const body = m[1] ?? '';
      if (body.trim().length >= 20 && IMPERATIVE.test(body)) {
        const line = textContent.slice(0, m.index).split('\n').length;
        push(
          'AHUB-P005',
          line,
          1,
          t('HTML comment containing instructions: "{0}"', [body.trim().replace(/\s+/g, ' ').slice(0, 120)]),
        );
      }
    }
  }
  return findings;
}

export function scanFiles(inputs: ScanInput[]): Finding[] {
  return inputs.flatMap(scanFile);
}

export function hasBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'critical');
}

export function summarizeFindings(findings: Finding[]): { critical: number; warning: number; info: number } {
  const s = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) s[f.severity] += 1;
  return s;
}

const SARIF_LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  warning: 'warning',
  info: 'note',
};
const SECURITY_SEVERITY: Record<Severity, string> = { critical: '9.1', warning: '5.0', info: '1.0' };

/** Produit un rapport SARIF 2.1.0 acceptable par GitHub code scanning. */
export function toSarif(findings: Finding[], toolVersion: string): Record<string, unknown> {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ahub',
            informationUri: 'https://github.com/agenteca/agenteca-core',
            version: toolVersion,
            rules: RULES.map((r) => ({
              id: r.id,
              name: r.name,
              shortDescription: { text: t(r.description) },
              fullDescription: { text: t(r.description) },
              help: { text: t(r.help) },
              defaultConfiguration: { level: SARIF_LEVEL[r.severity] },
              properties: { tags: ['security'], 'security-severity': SECURITY_SEVERITY[r.severity] },
            })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.ruleId,
          level: SARIF_LEVEL[f.severity],
          message: { text: f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path.split('/').map(encodeURIComponent).join('/') },
                region: { startLine: f.line, startColumn: f.column },
              },
            },
          ],
          partialFingerprints: {
            primaryLocationLineHash: sha256Hex(`${f.ruleId}:${f.path}:${f.line}`).slice(0, 32),
          },
        })),
      },
    ],
  };
}
