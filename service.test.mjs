import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const label = 'io.github.adstastic.sidepulse-status';
const domain = `gui/${process.getuid?.()}`;

async function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sidepulse-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clone = join(root, `clone & <'">`);
  const home = join(root, 'home & space');
  const agents = join(home, 'Library', 'LaunchAgents');
  const plist = join(agents, `${label}.plist`);
  mkdirSync(clone);
  mkdirSync(agents, { recursive: true });
  const script = join(clone, 'service.mjs');
  const runtime = join(clone, 'quota.mjs');
  copyFileSync(new URL('./service.mjs', import.meta.url), script);
  writeFileSync(runtime, 'throw new Error("Do not run the runtime in this fixture");');
  const { manageService } = await import(pathToFileURL(script));
  const calls = [];
  const run = (command, options) => manageService(command, {
    home, env: {}, launchctl: (...args) => calls.push(args), ...options,
  });
  return { calls, plist, clone, runtime, run };
}

const mac = { skip: process.platform !== 'darwin' };

test('installs a private, validated agent and removes only its job', mac, async t => {
  const { calls, plist, clone, runtime, run } = await fixture(t);
  const env = {
    PATH: `${clone}/bin:/usr/bin`,
    SIDEPULSE_CLAUDE_ORG_UUID: 'fake-org',
    SIDEPULSE_REX: `${clone}/rex`,
    SIDEPULSE_REX_SOCKET: `${clone}/rex.sock`,
    SIDEPULSE_VOLUME: '/Volumes/Fake & card',
  };
  run('install', { env: { ...env, TOKEN: 'not-copied', SIDEPULSE_UNKNOWN: 'not-copied' }, launchctl: (...args) => {
    assert.equal(lstatSync(plist).mode & 0o777, 0o600);
    const job = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plist]));
    assert.deepEqual(job.ProgramArguments, [process.execPath, runtime]);
    assert.equal(job.Label, label);
    assert.equal(job.KeepAlive, true);
    assert.deepEqual(job.EnvironmentVariables, env);
    calls.push(args);
  } });
  const before = readFileSync(plist);
  assert.throws(() => run('install'));
  assert.deepEqual(readFileSync(plist), before);
  run('uninstall');
  run('uninstall');
  assert.throws(() => lstatSync(plist), { code: 'ENOENT' });
  assert.deepEqual(calls, [['bootstrap', domain, plist], ['bootout', `${domain}/${label}`]]);
});

test('leaves existing files with another label or a symlink untouched', mac, async t => {
  const { calls, plist, runtime, run } = await fixture(t);
  symlinkSync(runtime, plist);
  assert.throws(() => run('install'));
  assert.throws(() => run('uninstall'));
  assert.ok(lstatSync(plist).isSymbolicLink());
  rmSync(plist);
  const other = '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>other</string></dict></plist>';
  writeFileSync(plist, other, { mode: 0o600 });
  assert.throws(() => run('install'));
  assert.throws(() => run('uninstall'));
  assert.equal(readFileSync(plist, 'utf8'), other);
  assert.deepEqual(calls, []);
});

test('cleans up a failed install and keeps the plist if stop fails', mac, async t => {
  const { plist, run } = await fixture(t);
  const fail = status => () => { throw Object.assign(new Error('fake launchctl failure'), { status }); };
  assert.throws(() => run('install', { launchctl: fail(5) }), /fake launchctl failure/);
  assert.throws(() => lstatSync(plist), { code: 'ENOENT' });
  run('install');
  const job = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plist]));
  assert.deepEqual(job.EnvironmentVariables, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  assert.throws(() => run('uninstall', { launchctl: fail(5) }), /fake launchctl failure/);
  assert.ok(lstatSync(plist).isFile());
  run('uninstall', { launchctl: fail(3) });
  assert.throws(() => lstatSync(plist), { code: 'ENOENT' });
});
