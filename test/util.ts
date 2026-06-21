import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface CommitSpec {
  message: string;
  files?: Record<string, string>;
  authorName?: string;
  authorEmail?: string;
  committerName?: string;
  committerEmail?: string;
  /** "YYYY-MM-DD HH:MM:SS +ZZZZ" */
  date?: string;
}

export class TempRepo {
  readonly path: string;
  constructor() {
    this.path = mkdtempSync(join(tmpdir(), 'antint-test-'));
    this.git(['init', '-q', '-b', 'main']);
    this.git(['config', 'commit.gpgsign', 'false']);
    this.git(['config', 'core.autocrlf', 'false']);
  }

  git(args: string[], env?: NodeJS.ProcessEnv): string {
    return execFileSync('git', ['-C', this.path, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  commit(spec: CommitSpec): string {
    for (const [rel, content] of Object.entries(spec.files ?? { 'file.txt': 'x\n' })) {
      const abs = resolve(this.path, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    this.git(['add', '-A']);
    const date = spec.date ?? '2026-06-20 12:00:00 +0000';
    const env: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: spec.authorName ?? 'Anonymous',
      GIT_AUTHOR_EMAIL: spec.authorEmail ?? 'anonymous@users.noreply.github.com',
      GIT_COMMITTER_NAME: spec.committerName ?? spec.authorName ?? 'Anonymous',
      GIT_COMMITTER_EMAIL: spec.committerEmail ?? spec.authorEmail ?? 'anonymous@users.noreply.github.com',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    this.git(['commit', '-q', '--no-gpg-sign', '-m', spec.message], env);
    return this.git(['rev-parse', 'HEAD']).trim();
  }

  checkoutNew(branch: string): void {
    this.git(['checkout', '-q', '-b', branch]);
  }

  checkout(branch: string): void {
    this.git(['checkout', '-q', branch]);
  }

  mergeNoFf(branch: string, message: string): string {
    const env: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: 'Anonymous',
      GIT_AUTHOR_EMAIL: 'anonymous@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Anonymous',
      GIT_COMMITTER_EMAIL: 'anonymous@users.noreply.github.com',
      GIT_AUTHOR_DATE: '2026-06-20 12:00:00 +0000',
      GIT_COMMITTER_DATE: '2026-06-20 12:00:00 +0000',
    };
    this.git(['merge', '--no-ff', '--no-edit', '-m', message, branch], env);
    return this.git(['rev-parse', 'HEAD']).trim();
  }

  annotatedTag(name: string, message: string, taggerName: string, taggerEmail: string): void {
    this.git(['tag', '-a', name, '-m', message], {
      GIT_COMMITTER_NAME: taggerName,
      GIT_COMMITTER_EMAIL: taggerEmail,
      GIT_COMMITTER_DATE: '2026-06-20 12:00:00 +0000',
    });
  }

  cleanup(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}
