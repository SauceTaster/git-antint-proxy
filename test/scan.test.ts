import { afterEach, describe, expect, it } from 'vitest';
import {
  allCatalogRules,
  DEFAULT_CONFIG,
  loadRules,
  parsePush,
  parseTag,
  scan,
  scanPush,
  type AntintConfig,
} from '../dist/index.js';
import { TempRepo } from './util.js';

const repos: TempRepo[] = [];
function repo(): TempRepo {
  const r = new TempRepo();
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

function cfg(over: Partial<AntintConfig> = {}): AntintConfig {
  return { ...DEFAULT_CONFIG, ...over };
}

describe('catalog', () => {
  it('loads a substantial web-verified ruleset', () => {
    expect(allCatalogRules().length).toBeGreaterThan(120);
    expect(loadRules(DEFAULT_CONFIG).length).toBeGreaterThan(120);
  });

  it('every catalog regex compiles', () => {
    for (const r of allCatalogRules()) {
      if (r.kind === 'regex') expect(() => new RegExp(r.detect, r.flags)).not.toThrow();
    }
  });
});

describe('agentic-tool artifacts', () => {
  it('blocks the Claude Code generated/co-author trailers', () => {
    const r = repo();
    r.commit({
      message:
        'Add feature\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
      files: { 'a.txt': 'ok\n' },
    });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    expect(res.blocked).toBe(true);
    expect(res.findings.some((f) => f.family === 'agentic')).toBe(true);
  });

  it('flags committed agentic workflow files (CLAUDE.md)', () => {
    const r = repo();
    r.commit({ message: 'docs', files: { 'CLAUDE.md': '# project memory\n' } });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    expect(res.findings.some((f) => f.path === 'CLAUDE.md' && f.family === 'agentic')).toBe(true);
  });
});

describe('identity', () => {
  it('blocks a non-canonical author', () => {
    const r = repo();
    r.commit({
      message: 'x',
      authorName: 'Jane Dev',
      authorEmail: 'jane@example.com',
      committerName: 'Jane Dev',
      committerEmail: 'jane@example.com',
      files: { 'a.txt': 'ok\n' },
    });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    expect(res.findings.some((f) => f.ruleId === 'identity:non-canonical-author')).toBe(true);
    expect(res.blocked).toBe(true);
  });

  it('allow-lists configured identities', () => {
    const r = repo();
    r.commit({
      message: 'x',
      authorName: 'Jane Dev',
      authorEmail: 'jane@example.com',
      committerName: 'Jane Dev',
      committerEmail: 'jane@example.com',
      files: { 'a.txt': 'ok\n' },
    });
    const res = scan(r.path, 'HEAD', {
      config: cfg({ identity: { ...DEFAULT_CONFIG.identity, allow: ['Jane Dev <jane@example.com>'] } }),
    });
    expect(res.findings.some((f) => f.ruleId === 'identity:non-canonical-author')).toBe(false);
  });
});

describe('working time', () => {
  it('flags a non-UTC timezone offset', () => {
    const r = repo();
    r.commit({ message: 'x', date: '2026-06-20 12:00:00 +0530', files: { 'a.txt': 'ok\n' } });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    expect(res.findings.some((f) => f.ruleId === 'temporal:non-utc-tz')).toBe(true);
  });

  it('flags commits outside the configured working-hours window', () => {
    const r = repo();
    r.commit({ message: 'x', date: '2026-06-20 03:00:00 +0000', files: { 'a.txt': 'ok\n' } });
    const res = scan(r.path, 'HEAD', {
      config: cfg({ workingHours: { ...DEFAULT_CONFIG.workingHours, window: [9, 18] } }),
    });
    expect(res.findings.some((f) => f.ruleId === 'temporal:outside-working-hours')).toBe(true);
  });
});

describe('prompt leakage', () => {
  it('blocks tell-tale LLM phrasing committed into the tree (block rules are not muted by default)', () => {
    const r = repo();
    r.commit({
      message: 'impl',
      files: { 'f.js': 'function f() {\n  // As an AI language model, I cannot do that\n}\n' },
    });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    expect(res.counts.prompt).toBeGreaterThan(0);
    expect(res.blocked).toBe(true);
  });

  it('a severityCap demotes a family to non-blocking', () => {
    const r = repo();
    r.commit({
      message: 'impl',
      files: { 'f.js': '// As an AI language model, I cannot do that\n' },
    });
    const res = scan(r.path, 'HEAD', {
      config: cfg({ severityCap: { ...DEFAULT_CONFIG.severityCap, prompt: 'warn' } }),
    });
    expect(res.counts.prompt).toBeGreaterThan(0);
    expect(res.findings.some((f) => f.family === 'prompt' && f.severity === 'block')).toBe(false);
  });
});

describe('detection-bypass regressions (from review)', () => {
  it('scans added lines in files with non-ASCII paths (quotepath)', () => {
    const r = repo();
    r.commit({ message: 'x', files: { 'fïlé.txt': 'const x = 1;   \n' } });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    expect(res.findings.some((f) => f.ruleId === 'stylometry:trailing-whitespace' && f.path === 'fïlé.txt')).toBe(true);
  });

  it('scans content introduced by a merge commit (first-parent diff)', () => {
    const r = repo();
    r.commit({ message: 'base', files: { 'base.txt': 'base\n' } });
    r.checkoutNew('feature');
    r.commit({ message: 'feature work', files: { 'feature.txt': 'y\n' } });
    r.checkout('main');
    r.commit({ message: 'main work', files: { 'main2.txt': 'z\n' } });
    const mergeSha = r.mergeNoFf('feature', 'Merge feature');
    const push = parsePush(r.path, `HEAD~1..${mergeSha}`);
    const merge = push.commits.find((c) => c.parents.length > 1);
    expect(merge).toBeTruthy();
    expect(merge!.files.map((f) => f.path)).toContain('feature.txt');
  });

  it('scans annotated tag tagger identity and message', () => {
    const r = repo();
    r.commit({ message: 'rel', files: { 'a.txt': 'ok\n' } });
    r.annotatedTag('v1', 'Release\n\nCo-Authored-By: Claude <noreply@anthropic.com>', 'Jane Dev', 'jane@example.com');
    const push = parseTag(r.path, 'v1');
    expect(push).not.toBeNull();
    const res = scanPush(push!, DEFAULT_CONFIG);
    expect(res.findings.some((f) => f.ruleId === 'identity:non-canonical-author')).toBe(true);
    expect(res.findings.some((f) => f.family === 'agentic')).toBe(true);
  });

  it('treats -0000 as UTC', () => {
    const r = repo();
    r.commit({ message: 'x', date: '2026-06-20 12:00:00 -0000', files: { 'a.txt': 'ok\n' } });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    expect(res.findings.some((f) => f.ruleId === 'temporal:non-utc-tz')).toBe(false);
  });

  it('supports array rev-specs for set exclusion', () => {
    const r = repo();
    const c1 = r.commit({ message: 'one', files: { 'a.txt': 'a\n' } });
    const c2 = r.commit({ message: 'two', files: { 'b.txt': 'b\n' } });
    const res = scan(r.path, ['HEAD', '--not', c1], { config: DEFAULT_CONFIG });
    expect(res.push.commits.map((c) => c.sha)).toEqual([c2]);
  });

  it('keeps both author and committer temporal findings (dedup by evidence)', () => {
    const r = repo();
    r.commit({
      message: 'x',
      authorName: 'Anonymous',
      authorEmail: 'anonymous@users.noreply.github.com',
      date: '2026-06-20 12:00:00 +0530',
      files: { 'a.txt': 'ok\n' },
    });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    const tz = res.findings.filter((f) => f.ruleId === 'temporal:non-utc-tz');
    expect(tz.length).toBe(2); // author + committer
  });
});

describe('stylometry', () => {
  it('flags trailing whitespace and CRLF on added lines', () => {
    const r = repo();
    r.commit({ message: 'x', files: { 's.js': 'const x = 1;   \n' } });
    r.commit({ message: 'y', files: { 'c.js': 'const y = 2;\r\n' } });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    expect(res.findings.some((f) => f.ruleId === 'stylometry:trailing-whitespace')).toBe(true);
    expect(res.findings.some((f) => f.ruleId === 'stylometry:crlf-line-endings')).toBe(true);
  });
});

describe('clean push', () => {
  it('produces no findings for a fully scrubbed commit', () => {
    const r = repo();
    r.commit({ message: 'Update docs', date: '2026-06-20 12:00:00 +0000', files: { 'd.txt': 'hello world\n' } });
    const res = scan(r.path, 'HEAD', { config: DEFAULT_CONFIG });
    expect(res.findings).toHaveLength(0);
    expect(res.blocked).toBe(false);
  });
});

describe('family toggles', () => {
  it('suppresses a disabled family', () => {
    const r = repo();
    r.commit({
      message: 'x',
      authorName: 'Jane Dev',
      authorEmail: 'jane@example.com',
      committerName: 'Jane Dev',
      committerEmail: 'jane@example.com',
      files: { 'a.txt': 'ok\n' },
    });
    const res = scan(r.path, 'HEAD', {
      config: cfg({ families: { ...DEFAULT_CONFIG.families, identity: false } }),
    });
    expect(res.findings.some((f) => f.family === 'identity')).toBe(false);
  });
});

describe('parser', () => {
  it('captures identity, tz, and added lines', () => {
    const r = repo();
    r.commit({ message: 'init', date: '2026-06-20 12:00:00 -0700', files: { 'a.txt': 'line1\nline2\n' } });
    const push = parsePush(r.path, 'HEAD');
    expect(push.commits).toHaveLength(1);
    const c = push.commits[0]!;
    expect(c.author.tz).toBe('-0700');
    expect(c.files[0]!.addedLines.map((l) => l.text)).toEqual(['line1', 'line2']);
  });
});
