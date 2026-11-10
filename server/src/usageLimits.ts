/**
 * The account's plan usage, for the office's usage bars: the last report each
 * provider's usage bridge sent, kept in ~/.pixel-agents/usage-limits.json so a
 * restarted server still has it (reports only arrive while a CLI session is
 * open). Shared by both surfaces.
 *
 * Usage is the operator's account data, so it goes to privileged clients only:
 * the handshake sends it only to them and httpServer drops these broadcasts on
 * read-only sockets (PRIVILEGED_BROADCAST_TYPES).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import type {
  UsageAccount,
  UsageBridgeStatus,
  UsageLimits,
  UsageWindow,
} from '../../core/src/messages.js';
import type { HookProvider, ReportedUsage } from '../../core/src/provider.js';
import { accountForConfigDir, listAccounts, type ResolvedAccount } from './accounts.js';
import {
  DEFAULT_ACCOUNT_NAME,
  PIXEL_AGENTS_DIR,
  USAGE_LIMITS_FILE_NAME,
  USAGE_UNCHANGED_REFRESH_MS,
} from './constants.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';
import { toRealPathKey } from './pathKey.js';
import { hookProviders } from './providers/index.js';
import { isRecord } from './serverConfig.js';

/** Where an account's usage is kept: under the provider id alone when the
 *  report belongs to no configured account (and always, when none are
 *  configured), else under `<provider>:<account>`. A provider id never holds a
 *  colon (the usage route's pattern), so the two cannot collide. */
function usageKey(providerId: string, account: ResolvedAccount | undefined): string {
  return account ? `${providerId}:${account.id}` : providerId;
}

/**
 * The account a report belongs to: a configured one, undefined for the
 * unscoped slot, or 'unknown' when it has no slot at all.
 *
 * The unscoped slot is the CLI's default login. With accounts configured, a
 * report from a login that is neither one of them nor the default has nowhere
 * to go — filing it as the default would put one login's numbers under
 * another's name — so it is dropped.
 */
function reportAccount(
  provider: HookProvider,
  raw: unknown,
): ResolvedAccount | undefined | 'unknown' {
  const bridge = provider.usageBridge;
  const configDir = bridge?.reportConfigDir?.(raw);
  if (configDir === undefined) return undefined;
  const account = accountForConfigDir(configDir);
  if (account || listAccounts().length === 0) return account;
  const defaultDir = bridge?.defaultConfigDir?.();
  const isDefault =
    defaultDir !== undefined && toRealPathKey(configDir) === toRealPathKey(defaultDir);
  return isDefault ? undefined : 'unknown';
}

/**
 * The plans the office shows for a provider, in order — or undefined when it
 * is the single unlabelled one (no accounts configured, or a CLI with one
 * login). The CLI's default login leads as "Default" unless an account already
 * covers its directory.
 */
function usagePlans(provider: HookProvider): UsageAccount[] | undefined {
  const bridge = provider.usageBridge;
  const accounts = listAccounts();
  if (accounts.length === 0 || !bridge?.reportConfigDir) return undefined;
  const defaultDir = bridge.defaultConfigDir?.();
  const defaultCovered =
    defaultDir === undefined ||
    accounts.some((a) => toRealPathKey(a.configDir) === toRealPathKey(defaultDir));
  return [
    ...(defaultCovered ? [] : [{ name: DEFAULT_ACCOUNT_NAME }]),
    ...accounts.map(({ id, name }) => ({ id, name })),
  ];
}

/** A provider's last report: its windows and when it arrived (epoch ms). */
interface StoredUsage extends ReportedUsage {
  updatedAt: number;
}

/** Wire message types only privileged sockets receive. */
export const PRIVILEGED_BROADCAST_TYPES: ReadonlySet<string> = new Set([
  'usageLimits',
  'usageBridgeStatus',
]);

let cache: Record<string, StoredUsage> | null = null;

function usageFilePath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, USAGE_LIMITS_FILE_NAME);
}

function isWindow(value: unknown): value is UsageWindow {
  if (!isRecord(value)) return false;
  const { usedPercentage, resetsAt } = value;
  return (
    typeof usedPercentage === 'number' &&
    Number.isFinite(usedPercentage) &&
    typeof resetsAt === 'number' &&
    Number.isFinite(resetsAt)
  );
}

/** Parse the file's content, keeping only well-formed entries. */
function parseStored(raw: unknown): Record<string, StoredUsage> {
  const out: Record<string, StoredUsage> = {};
  if (!isRecord(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const { fiveHour, sevenDay, updatedAt } = entry;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) continue;
    out[id] = {
      updatedAt,
      ...(isWindow(fiveHour) ? { fiveHour } : {}),
      ...(isWindow(sevenDay) ? { sevenDay } : {}),
    };
  }
  return out;
}

function stored(): Record<string, StoredUsage> {
  if (cache) return cache;
  try {
    cache = parseStored(JSON.parse(fs.readFileSync(usageFilePath(), 'utf-8')));
  } catch {
    cache = {}; // absent or unreadable: no usage known yet
  }
  return cache;
}

/**
 * Take one report from a provider's usage bridge. Returns the `usageLimits`
 * message when the office should hear about it: the numbers moved, or the last
 * word is old enough that "updated N min ago" would mislead. A status line
 * runs on every assistant message, so identical reports in between are
 * dropped (null), not written.
 *
 * The report is filed under the account whose config directory it came from
 * (UsageBridge.reportConfigDir), so two logins never overwrite each other.
 *
 * A window missing from the report keeps its last value: Claude Code drops a
 * window once it resets, and the client already shows a window past its reset
 * time as full.
 */
export function recordUsageReport(
  provider: HookProvider,
  raw: unknown,
  now: number = Date.now(),
): UsageLimits | null {
  const limits = provider.usageBridge?.normalizeReport(raw);
  if (!limits) return null;
  const account = reportAccount(provider, raw);
  if (account === 'unknown') return null;
  const key = usageKey(provider.id, account);
  const all = stored();
  const prev = all[key];
  const next: StoredUsage = {
    ...(prev?.fiveHour ? { fiveHour: prev.fiveHour } : {}),
    ...(prev?.sevenDay ? { sevenDay: prev.sevenDay } : {}),
    ...limits,
    updatedAt: now,
  };
  const { updatedAt: _prevAt, ...prevWindows } = prev ?? { updatedAt: 0 };
  const { updatedAt: _nextAt, ...nextWindows } = next;
  const moved = !isDeepStrictEqual(prevWindows, nextWindows);
  if (!moved && prev && now - prev.updatedAt < USAGE_UNCHANGED_REFRESH_MS) return null;
  all[key] = next;
  try {
    writeJsonAtomic(usageFilePath(), all);
  } catch (err) {
    // The office still gets the report; only a restart would lose it.
    console.error('[Pixel Agents] Could not save usage limits:', err);
  }
  return usageLimitsMessage(provider.id, account);
}

/** The `usageLimits` message for a provider, or for one of its accounts (no
 *  windows when none is known). */
export function usageLimitsMessage(providerId: string, account?: ResolvedAccount): UsageLimits {
  const entry = stored()[usageKey(providerId, account)];
  return {
    type: 'usageLimits',
    providerId,
    ...(account ? { accountId: account.id, accountName: account.name } : {}),
    ...(entry ?? {}),
  };
}

/** The `usageBridgeStatus` message: install state, plus why a change failed. */
export function usageBridgeStatusMessage(
  provider: HookProvider,
  error?: string,
): UsageBridgeStatus {
  const plans = usagePlans(provider);
  return {
    type: 'usageBridgeStatus',
    providerId: provider.id,
    providerName: provider.displayName,
    installed: provider.usageBridge?.isInstalled() ?? false,
    disclosure: provider.usageBridge?.disclosure ?? '',
    ...(plans ? { accounts: plans } : {}),
    ...(error ? { error } : {}),
  };
}

/** What a privileged office is told about usage when it connects: for each
 *  provider with a usage bridge, in registration order, its install state and
 *  then its last known usage — one message per plan the status lists (the
 *  default login and each account), or a single unscoped one when it lists
 *  none. Both surfaces' handshakes send exactly this. */
export function usageSnapshotMessages(): Array<UsageBridgeStatus | UsageLimits> {
  const accounts = listAccounts();
  return hookProviders
    .filter((provider) => provider.usageBridge)
    .flatMap((provider) => {
      const status = usageBridgeStatusMessage(provider);
      const limits = (status.accounts ?? [{ name: '' }]).map((plan) =>
        usageLimitsMessage(
          provider.id,
          accounts.find((account) => account.id === plan.id),
        ),
      );
      return [status, ...limits];
    });
}

/**
 * Carry out the Usage Bars toggle: install (the click IS the consent — the
 * disclosure was on screen) or restore the user's status line. Never rejects;
 * answers with the ACTUAL install state and, on failure, the reason, so the
 * checkbox never shows an intent the file doesn't hold.
 */
export async function applyUsageBridgeChoice(
  provider: HookProvider,
  packageRoot: string | undefined,
  enabled: boolean,
): Promise<UsageBridgeStatus> {
  const bridge = provider.usageBridge;
  if (!bridge) return usageBridgeStatusMessage(provider);
  try {
    if (enabled) {
      if (!packageRoot) throw new Error('This server cannot install the usage bridge.');
      await bridge.install(packageRoot);
    } else {
      await bridge.uninstall();
    }
    return usageBridgeStatusMessage(provider);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[Pixel Agents] ${reason}`);
    return usageBridgeStatusMessage(provider, reason);
  }
}

/** Tests only: forget the cached file content. */
export function resetUsageLimitsCacheForTests(): void {
  cache = null;
}
