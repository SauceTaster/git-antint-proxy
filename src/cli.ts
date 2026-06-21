#!/usr/bin/env node
/**
 * antint — anti-attribution git proxy CLI.
 *
 *   antint scan [range]            inspect a commit range for attribution signals
 *   antint fix  [range] [--write]  show (or apply) metadata remediation
 *   antint rules [--family f]      list the active detection rules
 *   antint hook <pre-push|pre-receive>   run as a git hook (reads refs from stdin)
 *
 * Exit codes: 0 = clean/allowed, 1 = blocked, 2 = error.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { applyMetadataFix, planFix } from './autofix.js';
import { loadConfig } from './config.js';
import { parseTag } from './git/parse.js';
import { scan, scanPush } from './engine/scan.js';
import { allCatalogRules } from './rules/index.js';
import { formatJson, formatText } from './report.js';
import { BUILTINS } from './engine/builtins.js';
import type { Family } from './types.js';

interface Flags {
  positional: string[];
  json: boolean;
  color: boolean;
  strict: boolean;
  write: boolean;
  repo: string;
  config?: string;
  family?: string;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    positional: [],
    json: false,
    color: process.stdout.isTTY ?? false,
    strict: false,
    write: false,
    repo: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--json': f.json = true; break;
      case '--color': f.color = true; break;
      case '--no-color': f.color = false; break;
      case '--strict': f.strict = true; break;
      case '--write': f.write = true; break;
      case '--repo': f.repo = argv[++i] ?? f.repo; break;
      case '--config': f.config = argv[++i]; break;
      case '--family': f.family = argv[++i]; break;
      case '--help': case '-h': f.positional.push('help'); break;
      case '--version': case '-v': f.positional.push('version'); break;
      default:
        if (a.startsWith('-')) die(`unknown flag: ${a}`);
        f.positional.push(a);
    }
  }
  return f;
}

function die(msg: string): never {
  process.stderr.write(`antint: ${msg}\n`);
  process.exit(2);
}

function defaultRange(repo: string): string {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return '@{upstream}..HEAD';
  } catch {
    return 'HEAD';
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const ZERO = '0000000000000000000000000000000000000000';

function cmdScan(f: Flags): number {
  const range = f.positional[1] ?? defaultRange(f.repo);
  const base = loadConfig(f.repo, f.config);
  const config = { ...base, strict: f.strict || base.strict };
  const result = scan(f.repo, range, { config });
  process.stdout.write((f.json ? formatJson(result) : formatText(result, { color: f.color })) + '\n');
  return result.blocked ? 1 : 0;
}

function cmdFix(f: Flags): number {
  const range = f.positional[1] ?? defaultRange(f.repo);
  const config = loadConfig(f.repo, f.config);
  const result = scan(f.repo, range, { config });
  const plan = planFix(result);

  if (!f.write) {
    if (f.json) {
      process.stdout.write(JSON.stringify({ range, plan }, null, 2) + '\n');
    } else {
      process.stdout.write(`antint fix plan for ${range} (${plan.length} step(s)) — dry run\n`);
      for (const s of plan) {
        process.stdout.write(`  ${s.automated ? '[auto]' : '[manual]'} ${s.ruleId}: ${s.action}\n`);
      }
      process.stdout.write('\nRe-run with --write to apply automated metadata fixes (a backup branch is created).\n');
    }
    return result.blocked ? 1 : 0;
  }

  const res = applyMetadataFix(f.repo, range, config);
  process.stdout.write(`antint: rewrote metadata over ${res.range}; backup at ${res.backupBranch}\n`);
  const after = scan(f.repo, range, { config });
  process.stdout.write(formatText(after, { color: f.color }) + '\n');
  const manual = plan.filter((s) => !s.automated);
  if (manual.length) {
    process.stdout.write('\nManual steps still required (content/files/stylometry):\n');
    for (const s of manual) process.stdout.write(`  - ${s.ruleId}: ${s.action}\n`);
  }
  return after.blocked ? 1 : 0;
}

function cmdRules(f: Flags): number {
  const builtins = Object.values(BUILTINS).map((b) => ({
    id: b.id, title: b.title, family: b.family, severity: b.severity, kind: 'builtin', source: 'builtin',
  }));
  const rules = [...allCatalogRules(), ...builtins].filter(
    (r) => !f.family || r.family === (f.family as Family),
  );
  if (f.json) {
    process.stdout.write(JSON.stringify(rules, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`antint: ${rules.length} rule(s)\n`);
  for (const r of rules) {
    process.stdout.write(`  [${r.severity.padEnd(5)}] ${r.family.padEnd(10)} ${r.id}  ${r.title}\n`);
  }
  return 0;
}

function cmdHook(f: Flags): number {
  const kind = f.positional[1];
  if (kind !== 'pre-push' && kind !== 'pre-receive') die('hook requires pre-push or pre-receive');
  const base = loadConfig(f.repo, f.config);
  const config = { ...base, strict: f.strict || base.strict };
  const input = readStdin().trim();
  let blocked = false;

  for (const line of input.split('\n').filter(Boolean)) {
    const cols = line.trim().split(/\s+/);
    // pre-push:    <localRef> <localSha> <remoteRef> <remoteSha>  (ref=2, new=1, old=3)
    // pre-receive: <oldSha> <newSha> <ref>                        (ref=2, new=1, old=0)
    const ref = cols[2];
    const newSha = cols[1];
    const oldSha = kind === 'pre-push' ? cols[3] : cols[0];
    if (!newSha || newSha === ZERO) continue; // deletion

    let result;
    if (ref && ref.startsWith('refs/tags/')) {
      // Annotated tags carry tagger identity/date/message/signature; scan the tag
      // object. Lightweight tags fall back to scanning the pointed-to commit.
      const tagPush = parseTag(f.repo, newSha);
      result = tagPush ? scanPush(tagPush, config) : scan(f.repo, newSha, { config });
    } else {
      // refs/heads/*, refs/notes/* (note content lives in the note-commit diff), etc.
      const rev =
        oldSha && oldSha !== ZERO
          ? `${oldSha}..${newSha}`
          : [newSha, '--not', kind === 'pre-push' ? '--remotes' : '--all'];
      result = scan(f.repo, rev, { config });
    }

    if (result.findings.length) process.stderr.write(formatText(result, { color: f.color }) + '\n');
    if (result.blocked) blocked = true;
  }
  return blocked ? 1 : 0;
}

function main(): number {
  const f = parseArgs(process.argv.slice(2));
  const cmd = f.positional[0] ?? 'scan';
  switch (cmd) {
    case 'scan': return cmdScan(f);
    case 'fix': return cmdFix(f);
    case 'rules': return cmdRules(f);
    case 'hook': return cmdHook(f);
    case 'version':
    case '--version':
      process.stdout.write('git-antint-proxy 0.1.0\n');
      return 0;
    case 'help':
    case '--help':
      process.stdout.write(
        'antint <scan|fix|rules|hook> [range] [--json] [--strict] [--repo dir] [--config file] [--no-color]\n',
      );
      return 0;
    default:
      die(`unknown command: ${cmd}`);
  }
}

try {
  process.exit(main());
} catch (err) {
  die((err as Error).message);
}
