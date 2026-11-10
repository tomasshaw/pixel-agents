/**
 * Unit tests for usageStore: which messages it takes, and that a request is
 * answered by the next usageBridgeStatus ARRIVAL — even one carrying the same
 * value (a failed install re-reports what was already held).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeEach, test } from 'vitest';

import {
  awaitingAnswer,
  handleUsageMessage,
  resetUsageStoreForTests,
  usageEntry,
  usagePlans,
} from '../src/usage/usageStore.js';

const status = (installed: boolean, error?: string) => ({
  type: 'usageBridgeStatus',
  providerId: 'claude',
  providerName: 'Claude Code',
  installed,
  disclosure: 'd',
  ...(error ? { error } : {}),
});

beforeEach(() => resetUsageStoreForTests());

test('a status is kept per provider and counts as an arrival', () => {
  assert.equal(handleUsageMessage(status(false)), true);
  const entry = usageEntry('claude');
  assert.equal(entry.status?.installed, false);
  assert.equal(entry.seq, 1);
  assert.equal(usageEntry('other').seq, 0);
});

test('malformed usage messages are consumed but change nothing', () => {
  assert.equal(handleUsageMessage({ type: 'usageBridgeStatus', providerId: 'claude' }), true);
  assert.equal(handleUsageMessage({ type: 'usageLimits', providerId: 3 }), true);
  assert.deepEqual(usageEntry('claude'), { seq: 0 });
});

test('other messages are not usage messages', () => {
  assert.equal(handleUsageMessage({ type: 'hooksStatus', installed: true }), false);
});

test('limits are kept beside the status and do not count as an arrival', () => {
  handleUsageMessage(status(true));
  handleUsageMessage({ type: 'usageLimits', providerId: 'claude', updatedAt: 5 });
  const entry = usageEntry('claude');
  assert.equal(entry.limits?.updatedAt, 5);
  assert.equal(entry.status?.installed, true);
  assert.equal(entry.seq, 1);
});

test('the entry object is stable until a message changes it', () => {
  handleUsageMessage(status(false));
  assert.equal(usageEntry('claude'), usageEntry('claude'));
});

test('a request is pending until the next status arrives, even an equal one', () => {
  handleUsageMessage(status(false));
  const sentAt = usageEntry('claude').seq;
  assert.equal(awaitingAnswer(usageEntry('claude'), null), false);
  assert.equal(awaitingAnswer(usageEntry('claude'), sentAt), true);
  handleUsageMessage({ type: 'usageLimits', providerId: 'claude' });
  assert.equal(awaitingAnswer(usageEntry('claude'), sentAt), true);
  handleUsageMessage(status(false, 'nope'));
  assert.equal(awaitingAnswer(usageEntry('claude'), sentAt), false);
});

const limits = (used: number, accountId?: string) => ({
  type: 'usageLimits',
  providerId: 'claude',
  ...(accountId ? { accountId, accountName: accountId.toUpperCase() } : {}),
  fiveHour: { usedPercentage: used, resetsAt: 1_900_000_000 },
});

test('without a list of plans there is one, unlabelled', () => {
  handleUsageMessage(status(true));
  handleUsageMessage(limits(40));
  const plans = usagePlans(usageEntry('claude'));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].label, undefined);
  assert.equal(plans[0].limits?.fiveHour?.usedPercentage, 40);
});

test('each listed plan gets its own usage, in the listed order', () => {
  handleUsageMessage({
    ...status(true),
    accounts: [{ name: 'Default' }, { id: '2', name: 'Two' }, { id: 'b', name: 'Bee' }],
  });
  // Arrival order and integer-like ids must not reorder them.
  handleUsageMessage(limits(30, 'b'));
  handleUsageMessage(limits(20, '2'));
  handleUsageMessage(limits(10));
  const plans = usagePlans(usageEntry('claude'));
  assert.deepEqual(
    plans.map((p) => [p.key, p.label, p.limits?.fiveHour?.usedPercentage]),
    [
      ['', 'Default', 10],
      ['2', 'Two', 20],
      ['b', 'Bee', 30],
    ],
  );
  // Stable between messages: a useSyncExternalStore snapshot.
  assert.equal(usagePlans(usageEntry('claude')), plans);
});

test('usage held for a plan the status no longer lists is not drawn', () => {
  handleUsageMessage({
    ...status(true),
    accounts: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
  });
  handleUsageMessage(limits(30, 'b'));
  handleUsageMessage({ ...status(true), accounts: [{ id: 'a', name: 'A' }] });
  assert.deepEqual(
    usagePlans(usageEntry('claude')).map((p) => p.key),
    ['a'],
  );
  // And with the accounts gone altogether, the default login's usage is back.
  handleUsageMessage(limits(10));
  handleUsageMessage(status(true));
  const plans = usagePlans(usageEntry('claude'));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].limits?.fiveHour?.usedPercentage, 10);
});
