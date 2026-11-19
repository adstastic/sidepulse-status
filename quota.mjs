import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Alert, diskMinPercent, findSidePulseVolume, present } from './device.mjs';
import { readRexAttention } from './rex-attention.mjs';

const home = homedir();
const cliPath = [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
  dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
const exec = promisify(execFile);
const pollMs = 9_000;
const refreshMs = 5 * 60_000;
const retryMs = 30_000;
const maxAgeMs = 20 * 60_000;
const isoTimestamp = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function parseTimestamp(value, utcOnly = false) {
  const match = typeof value === 'string' && isoTimestamp.exec(value);
  if (!match || (utcOnly && match[2] !== 'Z' && match[2] !== '+00:00')) return NaN;
  // Date.parse can silently roll an invalid calendar date into the next month.
  const day = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(+day) || day.toISOString().slice(0, 10) !== match[1]) return NaN;
  return Date.parse(value);
}

function isCurrent(quota, now) {
  return quota !== null && quota.fetchedAt <= now && now - quota.fetchedAt <= maxAgeMs && now < quota.resetsAt;
}

function toRemainingPercent(quota, now) {
  return isCurrent(quota, now) ? 100 - quota.pct : null;
}

function parseQuota(pct, fetchedAt, resetsAt, now) {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  const quota = { pct, fetchedAt: parseTimestamp(fetchedAt, true), resetsAt: parseTimestamp(resetsAt) };
  return isCurrent(quota, now) ? quota : null;
}

export function selectQuota(payload, now = Date.now(), organizationUuid) {
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.accounts) || organizationUuid === '') return null;
  const matches = organizationUuid === undefined ? payload.accounts
    : payload.accounts.filter(row => row?.organizationUuid === organizationUuid);
  if (matches.length !== 1 || matches[0]?.usageStatus !== 'ok') return null;
  const { usage, usageFetchedAt } = matches[0];
  const { pct, resetsAt } = usage?.sevenDay ?? {};
  return parseQuota(pct, usageFetchedAt, resetsAt, now);
}

export function selectCodexQuota(payload, now = Date.now()) {
  if (!Array.isArray(payload) || payload.length !== 1) return null;
  const [row] = payload;
  if (row?.provider !== 'codex' || row.source !== 'oauth' || row.error != null) return null;
  const { secondary, updatedAt } = row.usage ?? {};
  if (secondary?.windowMinutes !== 10080) return null;
  return parseQuota(secondary.usedPercent, updatedAt, secondary.resetsAt, now);
}

const sources = {
  claude: {
    command: 'claude-swap', args: ['list', '--json'],
    select: payload => selectQuota(payload, Date.now(), process.env.SIDEPULSE_CLAUDE_ORG_UUID),
  },
  codex: {
    command: 'codexbar',
    args: ['usage', '--provider', 'codex', '--source', 'oauth', '--format', 'json', '--json-only'],
    select: selectCodexQuota,
  },
};

async function fetchQuota({ command, args, select }) {
  try {
    const { stdout } = await exec(command, args, {
      cwd: home,
      env: { HOME: home, PATH: cliPath },
      timeout: 45_000,
      killSignal: 'SIGKILL',
    });
    return select(JSON.parse(stdout));
  } catch {
    // Subprocess and parse errors can contain unfiltered account output.
    return null;
  }
}

export function parseBatteryPercent(output) {
  const rows = output.split(/\r?\n/).filter(line => /^\s*-?InternalBattery-\d+\b/.test(line));
  if (rows.length !== 1 || /\bpresent:\s*false\b/.test(rows[0])) return null;
  const match = /^\s*-?InternalBattery-\d+(?:[ \t]+\([^)]*\))?[ \t]+(\d{1,3})%;/.exec(rows[0]);
  const percent = Number(match?.[1]);
  return percent <= 100 ? percent : null;
}

async function readBatteryPercent() {
  try {
    const { stdout } = await exec('/usr/bin/pmset', ['-g', 'batt'], { timeout: 1000, killSignal: 'SIGKILL' });
    return parseBatteryPercent(stdout);
  } catch {
    return null;
  }
}

export async function readDiskPercent(read = statfs) {
  try {
    const { bavail, bsize } = await read('/System/Volumes/Data');
    if (!Number.isFinite(bavail) || bavail < 0 || !Number.isInteger(bsize) || bsize <= 0) return null;
    const fullBarBytes = 100_000_000_000;
    const fillPercent = (bavail * bsize / fullBarBytes) * 100;
    return Math.max(diskMinPercent, Math.min(100, fillPercent));
  } catch {
    return null;
  }
}

async function readAttention() {
  try {
    return await readRexAttention() === true;
  } catch {
    return false;
  }
}

export function selectAlert(batteryPercent, attention) {
  if (Number.isFinite(batteryPercent) && batteryPercent >= 0 && batteryPercent < 10) return Alert.BATTERY;
  return attention === true ? Alert.ATTENTION : Alert.NONE;
}

export function createQuotaPoll(readQuota, now = Date.now) {
  const providers = Object.keys(sources);
  const states = Object.fromEntries(providers.map(provider => [provider, {
    lastGood: null, nextRefreshAt: -Infinity, inFlight: false,
  }]));
  let lastPollAt;

  async function refresh(provider, state) {
    state.inFlight = true;
    const quota = await readQuota(provider).catch(() => null);
    const finishedAt = now();
    if (isCurrent(quota, finishedAt)) {
      state.lastGood = quota;
      state.nextRefreshAt = Math.min(finishedAt + refreshMs, quota.resetsAt);
    } else {
      state.nextRefreshAt = finishedAt + retryMs;
    }
    state.inFlight = false;
  }

  return () => {
    const polledAt = now();
    const afterGap = lastPollAt !== undefined && polledAt - lastPollAt > 2 * pollMs;
    lastPollAt = polledAt;
    const quotas = {};
    for (const provider of providers) {
      const state = states[provider];
      if (!state.inFlight && (afterGap || polledAt >= state.nextRefreshAt)) void refresh(provider, state);
      quotas[provider] = toRemainingPercent(state.lastGood, polledAt);
    }
    return quotas;
  };
}

async function run() {
  const pollQuota = createQuotaPoll(provider => fetchQuota(sources[provider]));
  let attention = false;
  async function refreshAttention() {
    const started = performance.now();
    attention = await readAttention();
    setTimeout(refreshAttention, Math.max(0, pollMs - (performance.now() - started)));
  }

  void refreshAttention();
  for (;;) {
    const started = performance.now();
    const [batteryPercent, disk] = await Promise.all([readBatteryPercent(), readDiskPercent()]);
    try {
      await present({ ...pollQuota(), disk }, selectAlert(batteryPercent, attention));
    } catch {
      // The device may be unplugged. Retry on the next poll.
    }
    await sleep(Math.max(0, pollMs - (performance.now() - started)));
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).includes('--check')) {
    const [claude, codex, disk, batteryPercent, attention, volume] = await Promise.all([
      fetchQuota(sources.claude), fetchQuota(sources.codex), readDiskPercent(), readBatteryPercent(), readAttention(),
      findSidePulseVolume(),
    ]);
    const now = Date.now();
    const safe = quota => {
      const remainingPercent = toRemainingPercent(quota, now);
      return remainingPercent === null ? null : { remainingPercent, resetsAt: new Date(quota.resetsAt).toISOString() };
    };
    console.log(JSON.stringify({ claude: safe(claude), codex: safe(codex), disk, batteryPercent, attention,
      volumeReady: volume !== null }));
  } else {
    await run();
  }
}
