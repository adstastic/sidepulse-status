import { execFileSync } from 'node:child_process';
import {
  chmodSync, constants, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { constants as os, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const label = 'io.github.adstastic.sidepulse-status';
const settings = ['SIDEPULSE_CLAUDE_ORG_UUID', 'SIDEPULSE_REX', 'SIDEPULSE_REX_SOCKET', 'SIDEPULSE_VOLUME'];
const usage = 'Usage: node service.mjs install|uninstall';
const plutil = (args, input) => execFileSync('/usr/bin/plutil', args, { input, stdio: 'pipe', encoding: 'utf8' });

export function manageService(command, {
  home = homedir(), env = process.env,
  launchctl = (...args) => execFileSync('/bin/launchctl', args, { stdio: 'pipe' }),
} = {}) {
  if (command !== 'install' && command !== 'uninstall') throw new Error(usage);
  const uid = process.getuid?.();
  if (process.platform !== 'darwin' || uid === 0) throw new Error('Run as your macOS user without sudo.');
  const domain = `gui/${uid}`;
  const agents = resolve(home, 'Library', 'LaunchAgents');
  const plist = join(agents, `${label}.plist`);

  if (command === 'uninstall') {
    const file = lstatSync(plist, { throwIfNoEntry: false });
    if (!file) return;
    if (!file.isFile() || file.uid !== uid || label !== plutil(['-extract', 'Label', 'raw', '-n', '-'],
      readFileSync(plist, { flag: constants.O_RDONLY | constants.O_NOFOLLOW }))) {
      throw new Error(`Refusing to remove ${plist}.`);
    }
    try {
      launchctl('bootout', `${domain}/${label}`);
    } catch (error) {
      if (error.status !== os.errno.ESRCH) throw error;
    }
    unlinkSync(plist);
    return;
  }

  const runtime = join(import.meta.dirname, 'quota.mjs');
  if (!lstatSync(runtime, { throwIfNoEntry: false })?.isFile()) throw new Error('quota.mjs is missing from this clone.');
  const job = {
    Label: label,
    ProgramArguments: [process.execPath, runtime],
    KeepAlive: true,
    EnvironmentVariables: {
      PATH: env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      ...Object.fromEntries(settings.filter(key => env[key] !== undefined).map(key => [key, env[key]])),
    },
  };
  const xml = plutil(['-convert', 'xml1', '-o', '-', '-'], JSON.stringify(job));
  plutil(['-lint', '-'], xml);
  const decoded = JSON.parse(plutil(['-convert', 'json', '-o', '-', '-'], xml));
  if (!isDeepStrictEqual(decoded, job)) throw new Error('The launch agent plist did not round-trip.');

  mkdirSync(agents, { recursive: true });
  const temp = mkdtempSync(join(agents, '.sidepulse-'));
  try {
    const staged = join(temp, 'agent.plist');
    writeFileSync(staged, xml, { mode: 0o600 });
    chmodSync(staged, 0o600);
    linkSync(staged, plist);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  try {
    launchctl('bootstrap', domain, plist);
  } catch (error) {
    unlinkSync(plist);
    throw error;
  }
}

if (import.meta.main) {
  try {
    manageService(process.argv.length === 3 ? process.argv[2] : undefined);
  } catch (error) {
    console.error(error.code === 'EEXIST' ? 'A plist already exists. Uninstall it before you install again.' : error.message);
    process.exitCode = 1;
  }
}
