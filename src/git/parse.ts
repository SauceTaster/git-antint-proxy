/**
 * Parse a git commit range (or a tag ref) into the `Push` domain model using
 * the git CLI.
 *
 * Everything here is read-only. We shell out to `git` rather than depend on a
 * pure-JS implementation so the proxy reads exactly what git itself records
 * (raw timezone offsets, signature status, rename detection, ...).
 *
 * `core.quotepath=false` is forced on every invocation so paths with non-ASCII
 * characters are emitted raw (and identically) by both `--name-status` and the
 * patch, instead of one being C-quoted — otherwise such files would silently
 * escape added-line and stylometry scanning.
 */

import { execFileSync } from 'node:child_process';
import type { Commit, FileChange, Identity, Push } from '../types.js';

const UNIT = '\x00'; // field separator (in git output)
const REC = '\x1e'; // record separator (ASCII RS; will not appear in messages)
// git emits these bytes via the %x00 / %x1e format tokens (the format arg itself
// must not contain raw NUL bytes — execFile rejects them).
const FMT_UNIT = '%x00';
const FMT_REC = '%x1e';

const MAX_BUFFER = 256 * 1024 * 1024;

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', ['-C', repoPath, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
}

function gitSafe(repoPath: string, args: string[]): string {
  try {
    return git(repoPath, args);
  } catch {
    return '';
  }
}

/** Parse git's `--date=raw` value: "1655728800 +0000" -> { timestamp, tz }. */
function parseRawDate(raw: string): { timestamp: number; tz: string } {
  const [ts, tz] = raw.trim().split(/\s+/);
  return { timestamp: Number(ts ?? 0), tz: tz ?? '+0000' };
}

function classifySignatureFromText(raw: string): Commit['signatureType'] | undefined {
  if (/-----BEGIN SSH SIGNATURE-----/.test(raw)) return 'ssh';
  if (/-----BEGIN PGP SIGNATURE-----/.test(raw)) return 'gpg';
  if (/-----BEGIN (?:SIGNED MESSAGE|PKCS7)-----/.test(raw)) return 'x509';
  return undefined;
}

function classifySignature(repoPath: string, sha: string): Commit['signatureType'] {
  return classifySignatureFromText(gitSafe(repoPath, ['cat-file', 'commit', sha])) ?? 'unknown';
}

/** Parse `-z --name-status` output into FileChange stubs (no added lines yet). */
function parseNameStatus(out: string): Map<string, FileChange> {
  const parts = out.split('\0').filter((p) => p.length > 0);
  const map = new Map<string, FileChange>();
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] ?? '';
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i++] ?? '';
      const newPath = parts[i++] ?? '';
      map.set(newPath, {
        path: newPath,
        oldPath,
        status: letter === 'R' ? 'renamed' : 'copied',
        addedLines: [],
        binary: false,
      });
    } else {
      const path = parts[i++] ?? '';
      const status: FileChange['status'] =
        letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'T' ? 'typechange' : 'modified';
      map.set(path, { path, status, addedLines: [], binary: false });
    }
  }
  return map;
}

/** Parse a unified=0 patch, attaching added lines (and binary flags) to changes. */
function attachAddedLines(patch: string, changes: Map<string, FileChange>): void {
  const lines = patch.split('\n');
  let current: FileChange | undefined;
  let newLine = 0; // running new-file line number within the current hunk
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      continue;
    }
    if (line.startsWith('Binary files ')) {
      // No +++ header precedes this for binaries; recover the path from the line.
      if (!current) {
        const m = /^Binary files (?:a\/)?.* and (?:b\/)?(.+) differ$/.exec(line);
        if (m && m[1] && m[1] !== '/dev/null') current = changes.get(m[1]);
      }
      if (current) current.binary = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      // "+++ b/path" or "+++ /dev/null" for deletions (quotepath=false => raw path)
      const p = line.slice(4).trim();
      current = p === '/dev/null' ? undefined : changes.get(p.replace(/^b\//, '')) ?? changes.get(p);
      continue;
    }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('@@')) {
      // "@@ -a[,b] +c[,d] @@" — c is the new-file start line.
      const m = /\+(\d+)/.exec(line.slice(2));
      newLine = m ? Number(m[1]) : 0;
      continue;
    }
    if (current && line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push({ n: newLine, text: line.slice(1) });
      newLine++;
    }
  }
}

/**
 * Compute the changed files of a commit. For ordinary and root commits this is
 * the diff against the (first) parent. For merge commits, diff-tree produces no
 * output by default — so we diff the merge against its first parent, which
 * surfaces conflict-resolution / evil-merge content that would otherwise bypass
 * all content scanning.
 */
function commitFiles(repoPath: string, sha: string, parents: string[]): FileChange[] {
  const target = parents.length > 1 ? [parents[0]!, sha] : ['--root', sha];
  const nameStatus = gitSafe(repoPath, ['diff-tree', '--no-commit-id', '-r', '-M', '-z', '--name-status', ...target]);
  if (!nameStatus) return [];
  const changes = parseNameStatus(nameStatus);
  const patch = gitSafe(repoPath, [
    'diff-tree', '--no-commit-id', '-r', '-M', '--unified=0', '-p', '--no-color', ...target,
  ]);
  if (patch) attachAddedLines(patch, changes);
  return [...changes.values()];
}

/** Read a file's full text at a given commit (for formatter-drift checks). */
export function readBlobAtCommit(repoPath: string, sha: string, path: string): string | null {
  try {
    return git(repoPath, ['show', `${sha}:${path}`]);
  } catch {
    return null;
  }
}

/** Read a file's raw bytes at a given commit (for binary-metadata scanning). */
export function readBlobBytes(repoPath: string, sha: string, path: string): Buffer | null {
  try {
    return execFileSync('git', ['-C', repoPath, 'show', `${sha}:${path}`], { maxBuffer: MAX_BUFFER });
  } catch {
    return null;
  }
}

export function isGitRepo(repoPath: string): boolean {
  return gitSafe(repoPath, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
}

/**
 * `range` is either a string (a rev range like "origin/main..HEAD" or a single
 * ref) or an array of raw rev-list arguments (e.g. ["<sha>", "--not", "--remotes"])
 * for callers that need set exclusion. String form is guarded with
 * `--end-of-options` so a value starting with '-' can't be read as an option.
 */
export type RevSpec = string | string[];

/**
 * Parse the commits in `range` into a Push (oldest-first).
 */
export function parsePush(repoPath: string, range: RevSpec): Push {
  const revArgs = typeof range === 'string' ? ['--end-of-options', range] : range;
  const rangeLabel = typeof range === 'string' ? range : range.join(' ');
  const format =
    FMT_REC + ['%H', '%P', '%an', '%ae', '%ad', '%cn', '%ce', '%cd', '%G?', '%B'].join(FMT_UNIT);
  const raw = git(repoPath, ['log', '--reverse', '--date=raw', `--format=${format}`, ...revArgs, '--']);

  const commits: Commit[] = [];
  for (const record of raw.split(REC)) {
    if (!record.trim()) continue;
    const fields = record.split(UNIT);
    if (fields.length < 10) continue;
    const [sha, parents, an, ae, ad, cn, ce, cd, gflag] = fields as string[];
    const message = fields.slice(9).join(UNIT).replace(/\n+$/, '');
    const a = parseRawDate(ad ?? '');
    const c = parseRawDate(cd ?? '');
    const author: Identity = { name: an ?? '', email: ae ?? '', timestamp: a.timestamp, tz: a.tz };
    const committer: Identity = { name: cn ?? '', email: ce ?? '', timestamp: c.timestamp, tz: c.tz };
    const signed = (gflag ?? 'N').trim() !== 'N';
    const fullSha = (sha ?? '').trim();
    const parentList = (parents ?? '').trim() ? (parents as string).trim().split(/\s+/) : [];
    commits.push({
      sha: fullSha,
      parents: parentList,
      author,
      committer,
      message,
      signed,
      signatureType: signed ? classifySignature(repoPath, fullSha) : undefined,
      files: commitFiles(repoPath, fullSha, parentList),
    });
  }

  return { range: rangeLabel, repoPath, commits };
}

/**
 * Parse an annotated-tag ref into a Push containing one synthetic "commit" whose
 * identity is the tagger and whose message is the tag message — so tagger name,
 * email, timezone, message, and signature flow through the same detectors as
 * commits. Lightweight tags (which point straight at a commit object) return
 * null; the caller should scan the pointed-to commit instead.
 */
export function parseTag(repoPath: string, ref: string): Push | null {
  const type = gitSafe(repoPath, ['cat-file', '-t', ref]).trim();
  if (type !== 'tag') return null;
  const raw = gitSafe(repoPath, ['cat-file', 'tag', ref]);
  if (!raw) return null;
  const sha = gitSafe(repoPath, ['rev-parse', ref]).trim();

  const headerEnd = raw.indexOf('\n\n');
  const header = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
  const body = headerEnd >= 0 ? raw.slice(headerEnd + 2) : '';
  const taggerLine = header.split('\n').find((l) => l.startsWith('tagger ')) ?? '';
  // "tagger Name <email> <unixts> <tz>"
  const m = /^tagger (.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(taggerLine);
  const tagger: Identity = m
    ? { name: m[1]!, email: m[2]!, timestamp: Number(m[3]), tz: m[4]! }
    : { name: '', email: '', timestamp: 0, tz: '+0000' };

  const sigType = classifySignatureFromText(body);
  const message = sigType ? body.replace(/-----BEGIN (?:PGP|SSH) SIGNATURE-----[\s\S]*$/m, '').trimEnd() : body.trimEnd();

  return {
    range: ref,
    repoPath,
    commits: [
      {
        sha,
        parents: [],
        author: tagger,
        committer: tagger,
        message,
        signed: Boolean(sigType),
        signatureType: sigType,
        files: [],
      },
    ],
  };
}
