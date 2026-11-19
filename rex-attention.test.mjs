import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fakeRex = String.raw`#!/usr/bin/env node
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fixture = JSON.parse(process.env.SIDEPULSE_REX_FIXTURE);
const [noStart, timeoutArg, timeout, serverArg, target, ...args] = process.argv.slice(2);
assert.equal(noStart, '--autostart=false');
assert.equal(timeoutArg, '--timeout');
assert.match(timeout, /^[1-9]s$/);
assert.equal(serverArg, '-S');
assert.ok(!Object.keys(process.env).some(key => key.startsWith('REX_')));
assert.equal(process.cwd(), require('node:fs').realpathSync(process.env.HOME));
const local = 'unix://' + (fixture.socket ?? (process.env.HOME + '/Library/Application Support/rex/server.sock'))
  .split('/').map(encodeURIComponent).join('/');
if (args[0] === 'hosts') {
  assert.deepEqual(args, ['hosts', 'list', '--json']);
  assert.equal(target, local);
  if (fixture.remotes === null) process.exit(1);
  console.log(JSON.stringify({ hosts: fixture.remotes.map(label => ({ host: { label } })) }));
  process.exit(0);
}
assert.deepEqual(args.slice(0, 3), ['do', '--all', '-e']);
assert.deepEqual(args.slice(4), ['--json']);
const records = fixture.records[target === local ? 'local' : target];
if (records === undefined) process.exit(1);
const lua = [
  'local attached, reads = {}, 0',
  'rex = {}',
  'function rex.call(method, scope)',
  '  if method == "session.list" then return {sessions={{session_id="one"}, {session_id="two"}}} end',
  '  local id = scope.session_id',
  '  assert(id == "one" or id == "two")',
  '  if method == "session.attach" then attached[id] = true; return {} end',
  '  assert(attached[id])',
  '  if method == "session.list_blocks" then',
  '    return {blocks={',
  '      {block_id="parked", creator_name="com.superlogical.terminal", placement="unplaced"},',
  '      {block_id="editor", creator_name="editor", placement="placed"},',
  '      {block_id="terminal", creator_name="com.superlogical.terminal", placement="placed"}',
  '    }}',
  '  end',
  '  assert(method == "com.superlogical.terminal.program_status" and type(scope.args) == "table")',
  '  if scope.block_id ~= "terminal" then return {records={{state="blocked", kind="permission"}}} end',
  '  reads = reads + 1',
  '  return {records=id == "two" and ' + records + ' or {}}',
  'end',
  'local result = (function()', args[3], 'end)()',
  'assert(reads == 2, "must read placed terminals across sessions")',
  'local fields = {}',
  'for key, value in pairs(result) do',
  '  assert(type(value) == "boolean" or type(value) == "number", "only emit flags and counts")',
  '  fields[#fields+1] = string.format("%q:%s", key, tostring(value))',
  'end',
  'print("{" .. table.concat(fields, ",") .. "}")',
].join('\n');
process.stdout.write(execFileSync('lua', ['-'], {input: lua}));
`;

const home = await mkdtemp(fileURLToPath(new URL('./.rex-test-', import.meta.url)));
const overrideCli = join(home, 'custom rex');
const entry = fileURLToPath(new URL('./rex-attention.mjs', import.meta.url));
const priorHome = process.env.HOME;
const priorTarget = process.env.REX_SERVER;
const priorCli = process.env.SIDEPULSE_REX;
const priorSocket = process.env.SIDEPULSE_REX_SOCKET;
let readRexAttention;
before(async () => {
  const executable = join(home, 'Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex');
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, fakeRex, { mode: 0o700 });
  await writeFile(overrideCli, fakeRex, { mode: 0o700 });
  delete process.env.SIDEPULSE_REX;
  delete process.env.SIDEPULSE_REX_SOCKET;
  process.env.HOME = home;
  process.env.REX_SERVER = 'ambient-must-not-be-used';
  ({ readRexAttention } = await import('./rex-attention.mjs'));
});
after(async () => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorTarget === undefined) delete process.env.REX_SERVER;
  else process.env.REX_SERVER = priorTarget;
  if (priorCli !== undefined) process.env.SIDEPULSE_REX = priorCli;
  if (priorSocket !== undefined) process.env.SIDEPULSE_REX_SOCKET = priorSocket;
  delete process.env.SIDEPULSE_REX_FIXTURE;
  await rm(home, { recursive: true, force: true });
});

async function poll(records, remotes = []) {
  process.env.SIDEPULSE_REX_FIXTURE = JSON.stringify({ records, remotes });
  return readRexAttention();
}

const permission = '{{state="blocked", kind="permission"}}';
const touchId = '{{state="blocked", kind="auth", title="Unlock with tOuCh iD"}}';

for (const [name, records, expected] of [
  ['blocked permission without text', permission, true],
  ['case-insensitive Touch ID in auth title', touchId, true],
  ['Touch ID in message without a kind', '{{state="blocked", msg="Use Touch ID."}}', true],
  ['question with Touch ID', '{{state="blocked", kind="question", msg="Use Touch ID?"}}', false],
  ['generic question without a kind', '{{state="blocked", msg="What next?"}}', false],
  ['generic authentication', '{{state="blocked", kind="auth", msg="Authenticate to continue"}}', false],
  ['Touch ID substring is not a phrase', '{{state="blocked", kind="auth", title="Touch Identity", msg="preTouch ID"}}', false],
  ['working and done are not blocked', '{{state="working", kind="permission"}, {state="done", title="Touch ID"}}', false],
  ['no records at a placed terminal', '{}', false],
]) {
  test(name, async () => assert.equal(await poll({ local: records }), expected));
}

test('polls configured remotes and drops unavailable hosts from the next result', async () => {
  assert.equal(await poll({ local: '{}', 'fixture-remote': touchId }, ['offline', 'fixture-remote']), true);
  assert.equal(await poll({ local: '{}' }, ['offline', 'fixture-remote']), false);
});

test('check honors explicit Rex executable and socket, with flags and counts only', () => {
  const socket = join(home, 'test socket #1.sock');
  const record = { attention: true, complete: true, sessions: 2, terminals: 2, reads: 2 };
  const env = {
    ...process.env,
    SIDEPULSE_REX: overrideCli,
    SIDEPULSE_REX_SOCKET: socket,
    SIDEPULSE_REX_FIXTURE: JSON.stringify({
      socket, records: { local: '{}', 'fixture-remote': permission }, remotes: ['fixture-remote'],
    }),
  };
  const stdout = execFileSync(process.execPath, [entry, '--check'], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(stdout), {
    attention: true, discoveryOK: true, local: { ...record, attention: false }, remotes: [record],
  });
  for (const override of [{ SIDEPULSE_REX: 'custom rex' }, { SIDEPULSE_REX_SOCKET: 'test.sock' }]) {
    const result = spawnSync(process.execPath, [entry, '--check'], { env: { ...env, ...override }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { attention: false, discoveryOK: false, local: null, remotes: [] });
  }
});

test('keeps current local permission attention even if host discovery fails', async () => {
  assert.equal(await poll({ local: permission }, null), true);
  assert.equal(await poll({}, null), false);
});
