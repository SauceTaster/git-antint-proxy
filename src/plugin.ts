/**
 * FINOS git-proxy adapter.
 *
 * Lets the anti-attribution engine run as a step in a FINOS git-proxy push
 * chain (https://git-proxy.finos.org/docs/development/plugins/). FINOS is an
 * optional peer dependency: if it isn't installed you can still use
 * `runAntintOnAction` directly, or the standalone CLI / pre-receive hook.
 *
 * Usage in a FINOS plugin module:
 *
 *   import { createAntintPushPlugin } from 'git-antint-proxy/plugin';
 *   export default await createAntintPushPlugin();
 */

import { resolve } from 'node:path';
import { type AntintConfig, loadConfig } from './config.js';
import { scan } from './engine/scan.js';
import type { RevSpec } from './git/parse.js';
import { formatText } from './report.js';
import type { ScanResult } from './types.js';

/** The subset of a FINOS `Action` we rely on. */
export interface FinosAction {
  proxyGitPath?: string;
  repoName?: string;
  commitFrom?: string;
  commitTo?: string;
  error?: boolean;
  errorMessage?: string;
  blocked?: boolean;
  blockedMessage?: string;
  // FINOS calls this to continue the chain.
  continue?: () => unknown;
  [k: string]: unknown;
}

const ZERO = '0000000000000000000000000000000000000000';

function deriveRepoPath(action: FinosAction): string {
  if (action.proxyGitPath && action.repoName) return resolve(action.proxyGitPath, action.repoName);
  if (action.proxyGitPath) return action.proxyGitPath;
  return process.cwd();
}

function deriveRange(action: FinosAction): RevSpec {
  const to = action.commitTo;
  const from = action.commitFrom;
  if (to && from && from !== ZERO) return `${from}..${to}`;
  // New branch: scan only commits not already on a remote, not all reachable history.
  if (to) return [to, '--not', '--remotes'];
  return 'HEAD';
}

/**
 * Run the scan against a FINOS action and mark it blocked if attribution
 * signals require it. Returns the ScanResult for logging/inspection.
 */
export function runAntintOnAction(action: FinosAction, config?: AntintConfig): ScanResult {
  const repoPath = deriveRepoPath(action);
  const range = deriveRange(action);
  const result = scan(repoPath, range, { config: config ?? loadConfig(repoPath) });
  if (result.blocked) {
    // Policy rejection (not an internal error): set FINOS block fields.
    action.blocked = true;
    action.blockedMessage = formatText(result, { color: false });
  }
  return result;
}

/**
 * Build a FINOS PushActionPlugin instance. Resolves `@finos/git-proxy/plugin`
 * at call time so the dependency stays optional.
 */
export async function createAntintPushPlugin(config?: AntintConfig): Promise<unknown> {
  type PluginModule = {
    PushActionPlugin: new (fn: (req: unknown, action: FinosAction) => Promise<FinosAction>) => unknown;
  };
  let mod: PluginModule;
  try {
    // Built dynamically so TS/bundlers don't try to resolve the optional dep.
    const spec = ['@finos', 'git-proxy', 'plugin'].join('/');
    mod = (await import(spec)) as PluginModule;
  } catch {
    throw new Error(
      'createAntintPushPlugin requires @finos/git-proxy to be installed. ' +
        'Without it, use runAntintOnAction() directly or the antint CLI / pre-receive hook.',
    );
  }
  return new mod.PushActionPlugin(async (_req: unknown, action: FinosAction) => {
    runAntintOnAction(action, config);
    return action;
  });
}
