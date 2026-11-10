/**
 * Accounts: the CLI logins agents can run under.
 *
 * A CLI keeps one login per config directory (Claude Code: CLAUDE_CONFIG_DIR,
 * `~/.claude` by default), so "which account" is "which config directory".
 * Accounts are listed in the shared config (`accounts` in
 * ~/.pixel-agents/config.json) and used in three places:
 *
 * - a Directory names the account its agents launch under (directories.ts);
 * - sessions are looked for under every account's directory, so an agent
 *   started in a terminal under any of them is found;
 * - the usage bars are kept per account (usageLimits.ts).
 *
 * With none listed everything behaves as it did before accounts existed: one
 * implicit account, the CLI's default.
 */

import * as os from 'os';
import * as path from 'path';

import type { Account } from '../../core/src/messages.js';
import { readConfig } from './configPersistence.js';
import { toRealPathKey } from './pathKey.js';

/** An account with its config directory as an absolute path: the user's own
 *  spelling with a leading `~` expanded and nothing else touched. The CLI may
 *  key a login on the exact string (Claude Code names its keychain entry after
 *  it), so the path handed to it must be the one the user exports themselves. */
export interface ResolvedAccount {
  id: string;
  name: string;
  configDir: string;
}

function resolveConfigDir(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
}

/** The configured accounts, read fresh from the shared config. */
export function listAccounts(): ResolvedAccount[] {
  return readConfig().accounts.map((account) => ({
    id: account.id,
    name: account.name,
    configDir: resolveConfigDir(account.configDir),
  }));
}

/** The account with this id, or undefined (also for an absent id). */
export function accountById(id: string | undefined): ResolvedAccount | undefined {
  if (id === undefined) return undefined;
  return listAccounts().find((account) => account.id === id);
}

/** The account whose config directory is `configDir`, or undefined. */
export function accountForConfigDir(configDir: string): ResolvedAccount | undefined {
  const key = toRealPathKey(configDir);
  return listAccounts().find((account) => toRealPathKey(account.configDir) === key);
}

/** The account a file (a session transcript) belongs to: the one whose config
 *  directory holds it. The longest match wins, for nested directories. */
export function accountForFile(filePath: string): ResolvedAccount | undefined {
  const key = toRealPathKey(filePath);
  return listAccounts()
    .map((account) => ({ account, dir: toRealPathKey(account.configDir) }))
    .filter(({ dir }) => key.startsWith(dir + path.sep))
    .sort((a, b) => b.dir.length - a.dir.length)[0]?.account;
}

/** The accounts as the office is told about them: no paths, only what a
 *  picker needs. */
export function accountsForOffice(): Account[] {
  return listAccounts().map(({ id, name }) => ({ id, name }));
}
