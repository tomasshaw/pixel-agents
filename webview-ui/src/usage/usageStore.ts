/**
 * Each provider's usage bridge state and plan usage, as the server last sent
 * them (usageBridgeStatus, usageLimits), outside React like
 * office/contextGauge.ts: the Intro, Settings and the usage bars all read the
 * same entry (useUsageBridge).
 *
 * `seq` counts usageBridgeStatus ARRIVALS. A failed install re-reports the
 * value already held, so only an arrival settles a request: a click remembers
 * the seq it saw, and the request is answered once seq moves on.
 */

import type { UsageBridgeStatus, UsageLimits } from '../../../core/src/messages.js';

export interface UsageEntry {
  status?: UsageBridgeStatus;
  /** Usage of the CLI's default login (the only kind when the host has no
   *  accounts configured). */
  limits?: UsageLimits;
  /** Usage per account, keyed by `accountId`. Which of them are drawn, and
   *  in what order, is the status's say (usagePlans). */
  accounts?: Record<string, UsageLimits>;
  /** usageBridgeStatus arrivals so far. */
  seq: number;
}

const EMPTY: UsageEntry = { seq: 0 };
const entries = new Map<string, UsageEntry>();
const listeners = new Set<() => void>();

/** Take a usage message (useExtensionMessages). Returns whether it was one,
 *  accepted or not. A status needs a string providerId and a boolean
 *  installed; limits a string providerId. */
export function handleUsageMessage(msg: { type?: unknown; [key: string]: unknown }): boolean {
  if (msg.type === 'usageBridgeStatus') {
    if (typeof msg.providerId === 'string' && typeof msg.installed === 'boolean') {
      const status = msg as unknown as UsageBridgeStatus;
      const prev = usageEntry(status.providerId);
      update(status.providerId, { ...prev, status, seq: prev.seq + 1 });
    }
    return true;
  }
  if (msg.type === 'usageLimits') {
    if (typeof msg.providerId === 'string') {
      const limits = msg as unknown as UsageLimits;
      const prev = usageEntry(limits.providerId);
      update(
        limits.providerId,
        typeof limits.accountId === 'string'
          ? { ...prev, accounts: { ...prev.accounts, [limits.accountId]: limits } }
          : { ...prev, limits },
      );
    }
    return true;
  }
  return false;
}

/** A provider's entry; the same object until a message changes it. */
export function usageEntry(providerId: string): UsageEntry {
  return entries.get(providerId) ?? EMPTY;
}

/** The provider whose usage the office shows: the first the server reported a
 *  bridge status for (it reports them in registration order), or undefined
 *  before any arrives. */
export function usageProviderId(): string | undefined {
  for (const [id, entry] of entries) if (entry.status) return id;
  return undefined;
}

/** One plan as the bars draw it: whose it is, and its last known usage. */
export interface UsagePlan {
  /** The account id; '' for the CLI's default login. */
  key: string;
  /** The account's name, shown above its bars; absent with a single plan. */
  label?: string;
  limits: UsageLimits | undefined;
}

const planLists = new WeakMap<UsageEntry, UsagePlan[]>();

/**
 * The plans to draw for an entry, in the server's order. The status is the
 * authority on WHICH: it lists the plans (usageBridgeStatus.accounts), and
 * usage held for anything it doesn't list — an account since removed from the
 * host's config — is not drawn. Without a list there is one unlabelled plan.
 * The same array until a message changes the entry.
 */
export function usagePlans(entry: UsageEntry): UsagePlan[] {
  let plans = planLists.get(entry);
  if (!plans) {
    const listed = entry.status?.accounts;
    plans = listed
      ? listed.map((plan) => ({
          key: plan.id ?? '',
          label: plan.name,
          limits: plan.id === undefined ? entry.limits : entry.accounts?.[plan.id],
        }))
      : [{ key: '', limits: entry.limits }];
    planLists.set(entry, plans);
  }
  return plans;
}

/** Whether a request sent at `sentAtSeq` (null = none) still awaits its answer. */
export function awaitingAnswer(entry: UsageEntry, sentAtSeq: number | null): boolean {
  return sentAtSeq !== null && entry.seq === sentAtSeq;
}

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function update(providerId: string, entry: UsageEntry): void {
  entries.set(providerId, entry);
  for (const l of listeners) l();
}

/** Tests only: forget every entry. */
export function resetUsageStoreForTests(): void {
  entries.clear();
}
