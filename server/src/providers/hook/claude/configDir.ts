import * as os from 'os';
import * as path from 'path';

import { listAccounts } from '../../../accounts.js';
import { toRealPathKey } from '../../../pathKey.js';
import { CLAUDE_CONFIG_DIR_ENV } from './constants.js';

/** Where Claude Code keeps a login's settings, sessions and teams when
 *  CLAUDE_CONFIG_DIR is not set. */
export function defaultClaudeConfigDir(): string {
  return path.join(os.homedir(), '.claude');
}

/** The config directory an agent launched with this process's environment
 *  left alone ends up in: its CLAUDE_CONFIG_DIR when set, else the default. */
export function inheritedClaudeConfigDir(): string {
  return process.env[CLAUDE_CONFIG_DIR_ENV] || defaultClaudeConfigDir();
}

/** Whether two spellings name one config directory (symlinks and case folded). */
export function sameConfigDir(a: string, b: string): boolean {
  return toRealPathKey(a) === toRealPathKey(b);
}

/** Every config directory sessions may run under: the default, the one this
 *  process's environment names, then each configured account's. One real
 *  directory is listed once however many of those spell it, or a global scan
 *  would walk it twice and adopt each session twice. */
export function claudeConfigDirs(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of [
    defaultClaudeConfigDir(),
    inheritedClaudeConfigDir(),
    ...listAccounts().map((account) => account.configDir),
  ]) {
    const key = toRealPathKey(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}
