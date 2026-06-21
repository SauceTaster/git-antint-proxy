/**
 * Optional, opt-in remediation.
 *
 * Because this proxy is inspect-and-block, it never rewrites history on its own.
 * `applyMetadataFix` is an explicit local action (CLI: `antint fix --write`) that
 * scrubs the highest-severity *metadata* signals across a range:
 *   - author/committer identity  -> canonical anonymous identity
 *   - author/committer dates     -> UTC (optionally quantised)
 *   - GPG/SSH signatures         -> dropped (filter-branch recreates commits unsigned)
 *   - known attribution trailers -> stripped from messages
 *
 * Content/file/stylometry findings need working-tree edits and re-commits, so
 * they are returned as a manual plan rather than applied blindly.
 */

import { execFileSync } from 'node:child_process';
import type { AntintConfig } from './config.js';
import type { Finding, ScanResult } from './types.js';

export interface FixStep {
  ruleId: string;
  action: string;
  automated: boolean;
  command?: string;
}

const METADATA_FAMILIES = new Set(['identity', 'temporal']);
const AUTOMATED_RULE_PREFIXES = ['identity:', 'temporal:'];

function isAutomatable(f: Finding): boolean {
  if (f.ruleId === 'temporal:author-committer-skew' || f.ruleId === 'temporal:commit-burst') return false;
  if (AUTOMATED_RULE_PREFIXES.some((p) => f.ruleId.startsWith(p))) return true;
  // Commit-message trailers are stripped by the msg-filter.
  return f.family === 'agentic' && /trailer|coauthor|signed-off|generated/i.test(f.ruleId);
}

/** Build a human + machine remediation plan from a scan result. */
export function planFix(result: ScanResult): FixStep[] {
  const steps: FixStep[] = [];
  const seen = new Set<string>();
  for (const f of result.findings) {
    if (seen.has(f.ruleId)) continue;
    seen.add(f.ruleId);
    const automated = isAutomatable(f);
    steps.push({
      ruleId: f.ruleId,
      action: f.fix,
      automated,
      command: automated && METADATA_FAMILIES.has(f.family)
        ? `antint fix ${result.push.range} --write`
        : undefined,
    });
  }
  return steps;
}

function git(repoPath: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
}

export interface MetadataFixOptions {
  /** Where to point the backup branch. Defaults to a timestamped name. */
  backupBranch?: string;
}

export interface MetadataFixResult {
  backupBranch: string;
  range: string;
}

/**
 * Rewrite commit metadata across `range` with `git filter-branch`. Creates a
 * backup branch first. This mutates local history; the caller must have opted in.
 */
export function applyMetadataFix(
  repoPath: string,
  range: string,
  config: AntintConfig,
  opts: MetadataFixOptions = {},
): MetadataFixResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupBranch = opts.backupBranch ?? `antint-backup-${stamp}`;
  git(repoPath, ['branch', backupBranch]);

  const quantize = config.workingHours.mode === 'quantize' ? config.workingHours.bucketMinutes * 60 : 0;
  const utc = config.workingHours.mode !== 'off';

  const dateSnippet = (varName: string) =>
    utc
      ? `epoch=$(printf '%s' "$${varName}" | grep -oE '[0-9]+' | head -1); ` +
        (quantize > 0 ? `epoch=$(( epoch - epoch % ${quantize} )); ` : '') +
        `export ${varName}="$epoch +0000";`
      : '';

  // Identity is passed via the environment (ANTINT_NAME/ANTINT_EMAIL) and only
  // *referenced* by the shell snippet — never interpolated into it — so a name or
  // email containing shell metacharacters cannot inject commands.
  const envFilter = [
    'export GIT_AUTHOR_NAME="$ANTINT_NAME";',
    'export GIT_AUTHOR_EMAIL="$ANTINT_EMAIL";',
    'export GIT_COMMITTER_NAME="$ANTINT_NAME";',
    'export GIT_COMMITTER_EMAIL="$ANTINT_EMAIL";',
    dateSnippet('GIT_AUTHOR_DATE'),
    dateSnippet('GIT_COMMITTER_DATE'),
  ].join(' ');

  // Strip well-known attribution/co-author/sign-off/generated-with trailers.
  const msgFilter =
    `grep -ivE '^(Co-?authored-by|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Helped-by|Reported-by|Suggested-by|Reviewed-on):' ` +
    `| grep -ivE '(Generated with .?Claude Code|🤖 Generated with|^aider: )'`;

  git(
    repoPath,
    ['filter-branch', '-f', '--env-filter', envFilter, '--msg-filter', msgFilter, '--', range],
    {
      FILTER_BRANCH_SQUELCH_WARNING: '1',
      ANTINT_NAME: config.identity.name,
      ANTINT_EMAIL: config.identity.email,
    },
  );

  return { backupBranch, range };
}
