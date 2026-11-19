import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const home = homedir();
const rex = process.env.SIDEPULSE_REX ??
  join(home, 'Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex');
const socket = process.env.SIDEPULSE_REX_SOCKET ?? join(home, 'Library/Application Support/rex/server.sock');
const local = isAbsolute(socket) && !socket.includes('\0')
  ? `unix://${socket.split('/').map(encodeURIComponent).join('/')}` : null;
const exec = promisify(execFile);
const parallelHosts = 4;

const lua = `
local function call(method, scope)
  local ok, response = pcall(rex.call, method, scope)
  if ok then return response end
end

local function hasTouchId(text)
  return type(text) == 'string' and (' ' .. text:lower() .. ' '):find('[^%w_]touch id[^%w_]') ~= nil
end

local function requiresAttention(record)
  return type(record) == 'table' and record.state == 'blocked'
    and (record.kind == 'permission' or ((record.kind == 'auth' or record.kind == nil)
      and (hasTouchId(record.msg) or hasTouchId(record.title))))
end

local result = {attention=false, complete=true, sessions=0, terminals=0, reads=0}
local sessions = call('session.list', {})
if type(sessions) ~= 'table' or (sessions.sessions ~= nil and type(sessions.sessions) ~= 'table') then
  result.complete = false
  return result
end
for _, session in ipairs(sessions.sessions or {}) do
  result.sessions = result.sessions + 1
  local id = type(session) == 'table' and session.session_id
  local scope = {session_id=id}
  -- The status calls need a session attachment on this control connection.
  local attached = type(id) == 'string' and id ~= '' and call('session.attach', scope)
  local blocks = attached and call('session.list_blocks', scope)
  if type(blocks) ~= 'table' or (blocks.blocks ~= nil and type(blocks.blocks) ~= 'table') then
    result.complete = false
  else
    for _, block in ipairs(blocks.blocks or {}) do
      if type(block) == 'table' and block.creator_name == 'com.superlogical.terminal' and block.placement == 'placed' then
        result.terminals = result.terminals + 1
        local status = type(block.block_id) == 'string' and block.block_id ~= '' and
          call('com.superlogical.terminal.program_status', {session_id=id, block_id=block.block_id, args={}})
        if type(status) ~= 'table' or type(status.records) ~= 'table' then
          result.complete = false
        else
          result.reads = result.reads + 1
          for _, record in ipairs(status.records) do
            if requiresAttention(record) then result.attention = true end
          end
        end
      end
    end
  end
end
return result
`;

async function rexJson(target, ...args) {
  if (!isAbsolute(rex)) return null;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('REX_')));
    const { stdout } = await exec(rex, ['--autostart=false', '--timeout', '2s', '-S', target, ...args, '--json'], {
      cwd: home, env, timeout: 7000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    // Rex errors can contain the subprocess output.
    return null;
  }
}

async function readHost(target) {
  const result = await rexJson(target, 'do', '--all', '-e', lua);
  if (typeof result?.attention !== 'boolean' || typeof result.complete !== 'boolean') return null;
  const { attention, complete, sessions, terminals, reads } = result;
  if (![sessions, terminals, reads].every(n => Number.isSafeInteger(n) && n >= 0)
      || reads > terminals || (complete && reads !== terminals)) return null;
  return { attention, complete, sessions, terminals, reads };
}

async function pollRex() {
  if (!local) return { attention: false, discoveryOK: false, local: null, remotes: [] };
  const discovery = await rexJson(local, 'hosts', 'list');
  const labels = Array.isArray(discovery?.hosts) ? discovery.hosts.map(entry => entry?.host?.label) : null;
  const validLabel = label => typeof label === 'string' && label.trim().length > 0 && !label.includes('\0');
  const targets = [...new Set([local, ...(labels ?? []).filter(validLabel)])];
  const hosts = [];
  const pending = targets.entries();
  await Promise.all(Array.from({ length: Math.min(parallelHosts, targets.length) }, async () => {
    for (const [index, target] of pending) hosts[index] = await readHost(target);
  }));
  return {
    attention: hosts.some(host => host?.attention === true),
    discoveryOK: labels !== null && labels.every(validLabel),
    local: hosts[0],
    remotes: hosts.slice(1),
  };
}

export async function readRexAttention() {
  return (await pollRex()).attention;
}

if (import.meta.main && process.argv.length === 3 && process.argv[2] === '--check') {
  const status = await pollRex();
  console.log(JSON.stringify(status));
  if (!status.discoveryOK || !status.local?.complete || !status.remotes.every(host => host?.complete)) process.exitCode = 1;
}
