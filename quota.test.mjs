import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createQuotaPoll, parseBatteryPercent, readDiskPercent, selectAlert, selectCodexQuota, selectQuota } from './quota.mjs';

test('reads available bytes on the macOS data volume as fill on a 100 GB scale', async () => {
  for (const [bavail, expected] of [[0, 12.5], [1, 12.5], [19_531_250, 12.5],
    [97_656_250, 50], [195_312_500, 100], [390_625_000, 100]]) {
    assert.equal(await readDiskPercent(async path => {
      assert.equal(path, '/System/Volumes/Data');
      return { bavail, bsize: 512, bfree: 500_000_000, blocks: 1_000_000_000 };
    }), expected, `${bavail} available blocks`);
  }
});

test('unreadable or invalid disk stats are unavailable', async () => {
  assert.equal(await readDiskPercent(async () => { throw new Error('Volume unavailable'); }), null);
  for (const bavail of [undefined, null, '1', NaN, Infinity, -1]) {
    assert.equal(await readDiskPercent(async () => ({ bavail, bsize: 512 })), null, String(bavail));
  }
  for (const bsize of [undefined, null, '512', NaN, Infinity, -1, 0, 0.5]) {
    assert.equal(await readDiskPercent(async () => ({ bavail: 1, bsize })), null, String(bsize));
  }
});

const batteryOutput = (percent, power = 'AC Power', present = 'true') =>
  `Now drawing from '${power}'\n -InternalBattery-0 (id=1)\t${percent}%; charging; 0:00 remaining present: ${present}\n`;

test('reads only the internal battery percent and ignores the power source', () => {
  assert.equal(parseBatteryPercent(batteryOutput(9)), 9);
  assert.equal(parseBatteryPercent(batteryOutput(10, 'Battery Power')), 10);
  assert.equal(parseBatteryPercent(batteryOutput(0)), 0);
  assert.equal(parseBatteryPercent(batteryOutput(100)), 100);
  assert.equal(parseBatteryPercent(` -UPS-0\t1%; online\n${batteryOutput(50)}`), 50);
});

test('missing, ambiguous, or invalid internal battery data is unavailable', () => {
  for (const output of ['', ' -UPS-0\t1%; online\n', batteryOutput(9, 'AC Power', 'false'),
    batteryOutput(101), batteryOutput(-1), batteryOutput('NaN'), batteryOutput('9.5'),
    batteryOutput(9) + batteryOutput(90)]) {
    assert.equal(parseBatteryPercent(output), null);
  }
});

test('under 10% wins over attention, then attention wins over quotas', () => {
  for (const percent of [0, 9]) {
    assert.equal(selectAlert(percent, true), 'battery');
    assert.equal(selectAlert(percent, false), 'battery');
  }
  for (const percent of [10, 100, null, NaN, -1]) {
    assert.equal(selectAlert(percent, true), 'attention');
    assert.equal(selectAlert(percent, false), 'none');
  }
});

const now = Date.parse('2026-11-19T12:00:00Z');

function quotaPollFixture() {
  let time = now;
  const requests = { claude: [], codex: [] };
  const poll = createQuotaPoll(provider => {
    const request = Promise.withResolvers();
    requests[provider].push(request);
    return request.promise;
  }, () => time);
  return {
    requests,
    quota: (pct, { age = 0, resetIn = 3600 } = {}) => ({
      pct, fetchedAt: time - age * 1000, resetsAt: time + resetIn * 1000,
    }),
    poll: (seconds = 0) => {
      time += seconds * 1000;
      return poll();
    },
  };
}

test('both gauges show weekly quota remaining, including empty and full', async () => {
  for (const [used, remaining] of [[3, 97], [0, 100], [100, 0]]) {
    const { poll, quota, requests } = quotaPollFixture();
    poll();
    requests.claude[0].resolve(quota(used));
    requests.codex[0].resolve(quota(used));
    await setImmediate();
    assert.deepEqual(poll(), { claude: remaining, codex: remaining });
  }
});

test('a failed refresh keeps the last valid gauge and retries that provider after 30 seconds', async () => {
  const { poll, quota, requests } = quotaPollFixture();
  assert.deepEqual(poll(), { claude: null, codex: null });
  requests.claude[0].resolve(quota(50));
  requests.codex[0].resolve(quota(75));
  await setImmediate();
  for (let i = 0; i < 33; i++) poll(9);
  assert.equal(requests.claude.length, 1);
  assert.equal(requests.codex.length, 1);

  poll(9);
  requests.claude[1].resolve(null);
  requests.codex[1].resolve(quota(80));
  await setImmediate();
  for (let i = 0; i < 3; i++) assert.deepEqual(poll(9), { claude: 50, codex: 20 });
  assert.equal(requests.claude.length, 2);

  assert.deepEqual(poll(3), { claude: 50, codex: 20 });
  assert.equal(requests.claude.length, 3);
  assert.equal(requests.codex.length, 2);
  requests.claude[2].resolve(quota(55));
  await setImmediate();
  assert.deepEqual(poll(9), { claude: 45, codex: 20 });
});

test('the first poll after a wall gap starts refreshes without waiting or duplicating requests', async () => {
  const { poll, quota, requests } = quotaPollFixture();
  poll();
  requests.claude[0].resolve(quota(50));
  requests.codex[0].resolve(quota(75));
  await setImmediate();
  poll(18);
  assert.equal(requests.claude.length, 1);
  assert.equal(requests.codex.length, 1);

  assert.deepEqual(poll(19), { claude: 50, codex: 25 });
  assert.equal(requests.claude.length, 2);
  assert.equal(requests.codex.length, 2);
  requests.codex[1].resolve(quota(85));
  await setImmediate();
  assert.deepEqual(poll(19), { claude: 50, codex: 15 });
  assert.equal(requests.claude.length, 2);
  assert.equal(requests.codex.length, 3);
  requests.claude[1].reject(new Error('offline'));
  requests.codex[2].resolve(quota(85));
  await setImmediate();
  assert.deepEqual(poll(9), { claude: 50, codex: 15 });
});

test('age and reset still expire gauges while the providers are unavailable', async () => {
  const { poll, quota, requests } = quotaPollFixture();
  poll();
  requests.claude[0].resolve(quota(50, { age: 1170 }));
  requests.codex[0].resolve(quota(75, { resetIn: 36 }));
  await setImmediate();
  assert.deepEqual(poll(21), { claude: 50, codex: 25 });
  requests.claude[1].resolve(null);
  requests.codex[1].resolve(quota(75, { resetIn: 15 }));
  await setImmediate();
  assert.deepEqual(poll(9), { claude: 50, codex: 25 });
  assert.deepEqual(poll(1), { claude: null, codex: 25 });
  assert.deepEqual(poll(5), { claude: null, codex: null });
  assert.equal(requests.codex.length, 3);
});

const organizationUuid = '00000000-0000-4000-8000-000000000001';
const otherUuid = '00000000-0000-4000-8000-000000000002';
const usageFetchedAt = '2026-11-19T11:55:00Z';
const resetsAt = '2026-11-20T12:00:00.123Z';
const sevenDay = { pct: 50.0, resetsAt };
const account = (overrides = {}) => ({
  organizationUuid, usageStatus: 'ok', usageFetchedAt, usage: { sevenDay }, ...overrides,
});
const payload = (...accounts) => ({ schemaVersion: 1, accounts });
const select = (...accounts) => selectQuota(payload(...accounts), now, organizationUuid);
const withWindow = overrides => account({ usage: { sevenDay: { ...sevenDay, ...overrides } } });

test('selects only the pinned all-models weekly quota, including zero', () => {
  const other = account({ organizationUuid: otherUuid, active: true });
  const pinned = account({
    usage: { sevenDay: { ...sevenDay, pct: 0 }, fiveHour: { pct: 80 }, scoped: [{ pct: 90 }] },
  });
  assert.deepEqual(select(other, pinned), { pct: 0, fetchedAt: Date.parse(usageFetchedAt), resetsAt: Date.parse(resetsAt) });
  assert.equal(select(withWindow({ pct: 50.5 })).pct, 50.5);
  assert.equal(select(withWindow({ pct: 100 })).pct, 100);
  assert.equal(select(other), null);
});

test('without a workspace override only one account row is unambiguous', () => {
  assert.equal(selectQuota(payload(account({ organizationUuid: undefined })), now).pct, 50);
  assert.equal(selectQuota(payload(), now), null);
  assert.equal(selectQuota(payload(null), now), null);
  const another = account({ organizationUuid: otherUuid, usageStatus: 'unavailable' });
  assert.equal(selectQuota(payload(account({ active: true }), another), now), null);
  assert.equal(selectQuota(payload(account(), null), now), null);
  assert.equal(selectQuota(payload(account()), now, ''), null);
});

test('rejects missing or ambiguous data without falling back', () => {
  assert.equal(select(), null);
  assert.equal(select(account(), account({ usageStatus: 'unavailable', usage: null })), null);
  assert.equal(select(account({ usageStatus: 'unavailable' })), null);
  assert.equal(select(account({ usage: { fiveHour: sevenDay, scoped: [sevenDay] } })), null);
  assert.equal(select(account({ usage: null, lastGoodUsage: { sevenDay } })), null);
  for (const invalid of [null, {}, { schemaVersion: 1, accounts: {} }, { ...payload(account()), schemaVersion: 2 }]) {
    assert.equal(selectQuota(invalid, now), null);
  }
});

test('rejects invalid percentages', () => {
  for (const pct of [undefined, null, '50', NaN, Infinity, -0.1, 100.1]) {
    assert.equal(select(withWindow({ pct })), null, String(pct));
  }
});

test('rejects stale, future, missing, or invalid fetch times', () => {
  assert.notEqual(select(account({ usageFetchedAt: '2026-11-19T11:40:00+00:00' })), null);
  for (const usageFetchedAt of [undefined, 'bad', '2026-11-19T11:39:59.999Z', '2026-11-19T12:00:00.001Z', '2026-11-19T12:55:00+01:00']) {
    assert.equal(select(account({ usageFetchedAt })), null, String(usageFetchedAt));
  }
});

test('requires a valid reset strictly in the future', () => {
  assert.notEqual(select(withWindow({ resetsAt: '2026-11-19T13:00:00.001+01:00' })), null);
  for (const resetsAt of [undefined, '2026-11-20', '2026-11-20T12:00:00', '2026-11-19T13:00:00+01:00', '2026-11-19T11:59:59Z', '2027-02-29T12:00:00Z', '2026-11-20T24:00:00Z']) {
    assert.equal(select(withWindow({ resetsAt })), null, String(resetsAt));
  }
});

const codexNow = Date.parse('2026-11-18T21:20:00Z');
const updatedAt = '2026-11-18T21:19:38Z';
const secondary = { windowMinutes: 10080, usedPercent: 100, resetsAt: '2026-11-19T00:38:00Z' };
const codexRow = {
  provider: 'codex', source: 'oauth', usage: { secondary, updatedAt, identity: { label: 'fixture-only' } },
};
const withSecondary = overrides => [{ ...codexRow, usage: { ...codexRow.usage, secondary: { ...secondary, ...overrides } } }];
const selectCodex = payload => selectCodexQuota(payload, codexNow);

test('check uses trusted CLI directories, selects the configured workspace, and omits private fields', async t => {
  const home = await mkdtemp(fileURLToPath(new URL('./.quota-test-', import.meta.url)));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  const checkedAt = Date.now();
  const fetchedAt = new Date(checkedAt).toISOString();
  const resetsAt = new Date(checkedAt + 3600_000).toISOString();
  const rows = [account({ organizationUuid: otherUuid, active: true }), account({
    usageFetchedAt: fetchedAt, usage: { sevenDay: { pct: 38, resetsAt } }, label: 'fixture-only',
  })];
  const codex = [{ ...codexRow, usage: { ...codexRow.usage, updatedAt: fetchedAt,
    secondary: { ...secondary, usedPercent: 25, resetsAt } } }];
  for (const [command, json] of [['claude-swap', payload(...rows)], ['codexbar', codex]]) {
    await writeFile(join(bin, command), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(json)}'\n`, { mode: 0o700 });
    await writeFile(join(home, command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  }
  const entry = fileURLToPath(new URL('./quota.mjs', import.meta.url));
  const env = { HOME: home, PATH: home, SIDEPULSE_REX: 'disabled', SIDEPULSE_VOLUME: home };
  const check = overrides => JSON.parse(execFileSync(process.execPath, [entry, '--check'], {
    env: { ...env, ...overrides }, encoding: 'utf8',
  }));
  const chosen = check({ SIDEPULSE_CLAUDE_ORG_UUID: organizationUuid });
  assert.deepEqual(chosen.claude, { remainingPercent: 62, resetsAt });
  assert.deepEqual(chosen.codex, { remainingPercent: 75, resetsAt });
  assert.equal(chosen.attention, false);
  assert.equal(chosen.volumeReady, false);
  assert.deepEqual(Object.keys(chosen).sort(), ['attention', 'batteryPercent', 'claude', 'codex', 'disk', 'volumeReady']);
  assert.equal(check().claude, null);
  assert.deepEqual((await readdir(home)).sort(), ['.local', 'claude-swap', 'codexbar']);
});

test('selects the Codex OAuth weekly quota, including zero and 100 percent used', () => {
  for (const pct of [0, 50.5, 100]) {
    assert.deepEqual(selectCodex(withSecondary({ usedPercent: pct })), {
      pct, fetchedAt: Date.parse(updatedAt), resetsAt: Date.parse(secondary.resetsAt),
    });
  }
});

test('requires exactly one Codex OAuth row without errors', () => {
  const wrongProvider = { ...codexRow, provider: 'claude' };
  const wrongSource = { ...codexRow, source: 'cli' };
  for (const payload of [null, codexRow, [], [null], [wrongProvider], [wrongSource],
    [codexRow, codexRow], [codexRow, wrongProvider], [{ ...codexRow, error: 'unavailable' }]]) {
    assert.equal(selectCodex(payload), null);
  }
});

test('requires the numeric weekly window in secondary without falling back to primary', () => {
  for (const windowMinutes of [undefined, 300, '10080']) {
    assert.equal(selectCodex(withSecondary({ windowMinutes })), null);
  }
  assert.equal(selectCodex([{ ...codexRow, usage: { updatedAt, primary: secondary } }]), null);
});

test('rejects invalid Codex percentages and resets', () => {
  for (const usedPercent of [undefined, null, '50', NaN, Infinity, -0.1, 100.1]) {
    assert.equal(selectCodex(withSecondary({ usedPercent })), null);
  }
  for (const resetsAt of [undefined, '2026-11-19', '2026-11-18T21:20:00Z', '2027-02-29T12:00:00Z']) {
    assert.equal(selectCodex(withSecondary({ resetsAt })), null);
  }
});

test('requires a fresh UTC Codex update timestamp', () => {
  assert.notEqual(selectCodex([{ ...codexRow, usage: { ...codexRow.usage, updatedAt: '2026-11-18T21:00:00+00:00' } }]), null);
  for (const updatedAt of [undefined, 'bad', '2026-11-18T20:59:59.999Z', '2026-11-18T21:20:00.001Z', '2026-11-18T22:19:38+01:00']) {
    assert.equal(selectCodex([{ ...codexRow, usage: { ...codexRow.usage, updatedAt } }]), null);
  }
});
