/**
 * Builtin capability checks — the parts of attribution scrubbing that aren't a
 * simple regex/glob match: timezone & working-hour normalisation, commit cadence
 * (a behavioral-biometric channel; cf. Horvath et al. 2026), GPG/SSH signatures,
 * canonical-identity enforcement, and layout-level stylometry.
 *
 * Each check carries a stable rule id so it can be disabled via config and shown
 * in reports just like a catalog rule.
 */

import { execFileSync } from 'node:child_process';
import picomatch from 'picomatch';
import type { AntintConfig } from '../config.js';
import { readBlobAtCommit, readBlobBytes } from '../git/parse.js';
import type { Commit, Family, Finding, Identity, Push, Severity } from '../types.js';

interface BuiltinMeta {
  id: string;
  family: Family;
  severity: Severity;
  title: string;
  fix: string;
}

export const BUILTINS = {
  nonUtcTz: {
    id: 'temporal:non-utc-tz',
    family: 'temporal',
    severity: 'warn',
    title: 'Commit timezone offset is not UTC',
    fix: 'Set commit times to UTC (GIT_AUTHOR_DATE/GIT_COMMITTER_DATE with +0000) to hide geography.',
  },
  outsideHours: {
    id: 'temporal:outside-working-hours',
    family: 'temporal',
    severity: 'warn',
    title: 'Commit time-of-day reveals a schedule/timezone',
    fix: 'Commit times outside the configured window leak sleep/work patterns; normalise or batch commits.',
  },
  unquantized: {
    id: 'temporal:unquantized-time',
    family: 'temporal',
    severity: 'warn',
    title: 'Commit time is not quantised to the configured bucket',
    fix: 'Round commit timestamps to the configured bucket to blur fine-grained timing.',
  },
  skew: {
    id: 'temporal:author-committer-skew',
    family: 'temporal',
    severity: 'info',
    title: 'Author and committer dates differ widely',
    fix: 'Large author/committer skew can fingerprint a rebase/cherry-pick workflow; align the dates.',
  },
  burst: {
    id: 'temporal:commit-burst',
    family: 'temporal',
    severity: 'info',
    title: 'Commit cadence burst (behavioral fingerprint)',
    fix: 'Many commits in one minute is a cadence fingerprint; spread or squash.',
  },
  nonCanonicalAuthor: {
    id: 'identity:non-canonical-author',
    family: 'identity',
    severity: 'block',
    title: 'Author identity is not the canonical anonymous identity',
    fix: 'Rewrite author to config.identity (name/email) or allow-list this identity.',
  },
  nonCanonicalCommitter: {
    id: 'identity:non-canonical-committer',
    family: 'identity',
    severity: 'block',
    title: 'Committer identity is not the canonical anonymous identity',
    fix: 'Rewrite committer to config.identity (name/email) or allow-list this identity.',
  },
  signed: {
    id: 'identity:signed-commit',
    family: 'identity',
    severity: 'block',
    title: 'Commit is cryptographically signed (ties it to a key)',
    fix: 'Strip the GPG/SSH signature; a signature is a strong link to a real key/person.',
  },
  binaryMetadata: {
    id: 'identity:binary-metadata',
    family: 'identity',
    severity: 'warn',
    title: 'Binary file embeds authorship metadata (EXIF/XMP/PDF)',
    fix: 'Strip embedded metadata before committing media/documents, e.g. `exiftool -all= <file>`.',
  },
  crlf: {
    id: 'stylometry:crlf-line-endings',
    family: 'stylometry',
    severity: 'warn',
    title: 'CRLF line endings (layout fingerprint)',
    fix: 'Normalise to LF.',
  },
  trailingWs: {
    id: 'stylometry:trailing-whitespace',
    family: 'stylometry',
    severity: 'warn',
    title: 'Trailing whitespace on added lines',
    fix: 'Strip trailing whitespace (a habitual layout signal).',
  },
  indent: {
    id: 'stylometry:indent-style',
    family: 'stylometry',
    severity: 'warn',
    title: 'Indentation unit deviates from policy',
    fix: 'Normalise indentation to the configured unit.',
  },
  formatterDrift: {
    id: 'stylometry:formatter-drift',
    family: 'stylometry',
    severity: 'warn',
    title: 'Code is not in canonical formatter style',
    fix: 'Run the configured formatter so layout is canonical, not personal.',
  },
} satisfies Record<string, BuiltinMeta>;

function find(meta: BuiltinMeta, commit: Commit, extra: Partial<Finding> = {}): Finding {
  return {
    ruleId: meta.id,
    family: meta.family,
    severity: meta.severity,
    title: meta.title,
    commit: commit.sha,
    fix: meta.fix,
    ...extra,
  };
}

/** Parse a git tz offset like "-0730" into seconds east of UTC. */
function tzOffsetSeconds(tz: string): number {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(tz.trim());
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 3600 + Number(m[3]) * 60);
}

/** Local hour-of-day (0–23) for an identity, per its recorded offset. */
function localHour(id: Identity): number {
  const local = id.timestamp + tzOffsetSeconds(id.tz);
  return Math.floor((((local % 86400) + 86400) % 86400) / 3600);
}

// ---------------------------------------------------------------------------
// Temporal
// ---------------------------------------------------------------------------

export function temporalChecks(push: Push, config: AntintConfig): Finding[] {
  const wh = config.workingHours;
  if (wh.mode === 'off') return [];
  const out: Finding[] = [];
  const minuteBuckets = new Map<number, number>();

  for (const c of push.commits) {
    for (const [who, id] of [
      ['author', c.author],
      ['committer', c.committer],
    ] as const) {
      if (wh.mode === 'utc' && tzOffsetSeconds(id.tz) !== 0) {
        out.push(find(BUILTINS.nonUtcTz, c, { evidence: `${who} tz ${id.tz}` }));
      }
      if (wh.window) {
        const h = localHour(id);
        const [start, end] = wh.window;
        const inWindow = start <= end ? h >= start && h < end : h >= start || h < end;
        if (!inWindow) {
          out.push(find(BUILTINS.outsideHours, c, { evidence: `${who} local hour ~${h}:00` }));
        }
      }
      if (wh.mode === 'quantize') {
        const bucket = wh.bucketMinutes * 60;
        if (bucket > 0 && id.timestamp % bucket !== 0) {
          out.push(find(BUILTINS.unquantized, c, { evidence: `${who} ts ${id.timestamp}` }));
        }
      }
    }

    if (Math.abs(c.author.timestamp - c.committer.timestamp) > wh.maxAuthorCommitterSkewSeconds) {
      out.push(
        find(BUILTINS.skew, c, {
          evidence: `${Math.abs(c.author.timestamp - c.committer.timestamp)}s`,
        }),
      );
    }

    const minute = Math.floor(c.committer.timestamp / 60);
    minuteBuckets.set(minute, (minuteBuckets.get(minute) ?? 0) + 1);
  }

  for (const [minute, count] of minuteBuckets) {
    if (count > config.workingHours.maxCommitsPerMinute) {
      const c = push.commits.find((x) => Math.floor(x.committer.timestamp / 60) === minute)!;
      out.push(find(BUILTINS.burst, c, { evidence: `${count} commits in one minute` }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity (canonical author/committer + signatures)
// ---------------------------------------------------------------------------

function buildAllowSets(config: AntintConfig): { emails: Set<string>; exact: Set<string> } {
  const emails = new Set<string>();
  const exact = new Set<string>();
  const add = (entry: string) => {
    const e = entry.trim().toLowerCase();
    if (!e) return;
    const m = /<([^>]+)>/.exec(e);
    if (m) {
      emails.add(m[1]!.trim());
      exact.add(e);
    } else if (e.includes('@')) {
      emails.add(e);
    } else {
      exact.add(e);
    }
  };
  add(`${config.identity.name} <${config.identity.email}>`);
  emails.add(config.identity.email.toLowerCase());
  for (const a of config.identity.allow) add(a);
  return { emails, exact };
}

function identityAllowed(id: Identity, sets: { emails: Set<string>; exact: Set<string> }): boolean {
  const email = id.email.trim().toLowerCase();
  const exact = `${id.name} <${id.email}>`.trim().toLowerCase();
  return sets.emails.has(email) || sets.exact.has(exact);
}

export function identityChecks(push: Push, config: AntintConfig): Finding[] {
  const sets = buildAllowSets(config);
  const out: Finding[] = [];
  for (const c of push.commits) {
    if (!identityAllowed(c.author, sets)) {
      out.push(find(BUILTINS.nonCanonicalAuthor, c, { evidence: `${c.author.name} <${c.author.email}>` }));
    }
    if (!identityAllowed(c.committer, sets)) {
      out.push(
        find(BUILTINS.nonCanonicalCommitter, c, { evidence: `${c.committer.name} <${c.committer.email}>` }),
      );
    }
    if (c.signed) {
      out.push(find(BUILTINS.signed, c, { evidence: `${c.signatureType ?? 'unknown'} signature` }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stylometry (layout-level; AST-level is out of scope by design — see README)
// ---------------------------------------------------------------------------

export function stylometryChecks(push: Push, config: AntintConfig): Finding[] {
  const sty = config.stylometry;
  const out: Finding[] = [];
  const fmtGlobs = Object.entries(sty.formatters).map(([g, cmd]) => ({ match: picomatch(g, { dot: true }), cmd }));

  for (const c of push.commits) {
    for (const file of c.files) {
      if (file.binary || file.status === 'deleted') continue;

      let flaggedCrlf = false;
      let flaggedWs = false;
      let flaggedIndent = false;
      for (const ln of file.addedLines) {
        if (sty.enforceLf && !flaggedCrlf && /\r$/.test(ln.text)) {
          out.push(find(BUILTINS.crlf, c, { path: file.path, line: ln.n }));
          flaggedCrlf = true;
        }
        const body = ln.text.replace(/\r$/, '');
        if (sty.noTrailingWhitespace && !flaggedWs && /[ \t]+$/.test(body)) {
          out.push(find(BUILTINS.trailingWs, c, { path: file.path, line: ln.n }));
          flaggedWs = true;
        }
        if (!flaggedIndent && sty.indent !== 'any') {
          const bad = sty.indent === 'space' ? /^\t/.test(body) : /^ {2,}\S/.test(body);
          if (bad) {
            out.push(find(BUILTINS.indent, c, { path: file.path, line: ln.n, evidence: `wants ${sty.indent}` }));
            flaggedIndent = true;
          }
        }
      }

      // Formatter execution only happens for trusted config (never a
      // repo-discovered antint.config.json) and runs without a shell.
      if (sty.checkFormatterDrift && config.trustFormatters && fmtGlobs.length) {
        const fmt = fmtGlobs.find((g) => g.match(file.path));
        if (fmt) {
          const content = readBlobAtCommit(push.repoPath, c.sha, file.path);
          if (content != null) {
            try {
              const argv = fmt.cmd.split(/\s+/).filter(Boolean).map((a) => a.replace(/\{file\}/g, file.path));
              const [bin, ...rest] = argv;
              if (bin) {
                const formatted = execFileSync(bin, rest, {
                  input: content,
                  encoding: 'utf8',
                  maxBuffer: 64 * 1024 * 1024,
                });
                if (formatted.trimEnd() !== content.trimEnd()) {
                  out.push(find(BUILTINS.formatterDrift, c, { path: file.path }));
                }
              }
            } catch {
              // formatter not installed / failed — skip silently
            }
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Binary metadata (best-effort EXIF / XMP / PDF authorship extraction)
// ---------------------------------------------------------------------------

const MEDIA_GLOB = picomatch(
  '**/*.{jpg,jpeg,png,tif,tiff,heic,heif,webp,gif,pdf,docx,xlsx,pptx,doc,mp3,mp4,mov,m4a,wav,svg}',
  { dot: true, nocase: true },
);
const MAX_BINARY_BYTES = 25 * 1024 * 1024;

// Person-revealing metadata markers. We scan the raw bytes (latin1) and capture
// the embedded name. Tool/software fields (CreatorTool, Producer) are excluded.
const META_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'PDF /Author', re: /\/Author\s*\(([^)]{1,120})\)/ },
  { label: 'XMP dc:creator', re: /<dc:creator>[\s\S]{0,80}?<rdf:li[^>]*>([^<]{1,120})<\/rdf:li>/ },
  { label: 'XMP dc:creator', re: /<dc:creator>\s*([^<\s][^<]{0,118})\s*<\/dc:creator>/ },
  { label: 'XMP photoshop:Credit', re: /photoshop:Credit>([^<]{1,120})</ },
  { label: 'EXIF Artist', re: /Artist\x00+([\x20-\x7e]{2,80})/ },
  { label: 'PNG Author', re: /Author\x00([\x20-\x7e]{2,80})/ },
  { label: 'Office creator', re: /<dc:creator>([^<]{1,120})<\/dc:creator>/ },
];

export function binaryMetadataChecks(push: Push, config: AntintConfig): Finding[] {
  const out: Finding[] = [];
  const allow = config.allowPaths.map((g) => picomatch(g, { dot: true }));
  const allowed = (p: string) => allow.some((m) => m(p));

  for (const c of push.commits) {
    for (const file of c.files) {
      if (file.status === 'deleted' || allowed(file.path) || !MEDIA_GLOB(file.path)) continue;
      const bytes = readBlobBytes(push.repoPath, c.sha, file.path);
      if (!bytes || bytes.length > MAX_BINARY_BYTES) continue;
      const text = bytes.toString('latin1');
      for (const { label, re } of META_PATTERNS) {
        const m = re.exec(text);
        const name = m?.[1]?.trim();
        if (name && /[a-z]/i.test(name)) {
          out.push(find(BUILTINS.binaryMetadata, c, { path: file.path, evidence: `${label}: ${name.slice(0, 80)}` }));
          break; // one finding per file
        }
      }
    }
  }
  return out;
}
