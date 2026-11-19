import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const defaultVolumes = ['/Volumes/SidePulse', '/Volumes/SidePulsePro'];
const segments = 8;
const gauges = [
  { key: 'claude', rgb: [0xd9, 0x77, 0x57] },
  { key: 'codex', rgb: [0x39, 0x7d, 0xff] },
  { key: 'disk', rgb: [0x35, 0xd0, 0x5a] },
];
const quotaRise = ' 230ms';
const programLimit = 512;
const exec = promisify(execFile);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const fileFlags = constants.O_NOFOLLOW | constants.O_NONBLOCK;

export const Alert = Object.freeze({ NONE: 'none', BATTERY: 'battery', ATTENTION: 'attention' });
const alertPrograms = new Map([
  [Alert.BATTERY, '#b00000 140ms none\noff 200ms none\n#b00000 140ms none\noff 1000ms none\nrepeat\n'],
  [Alert.ATTENTION, '#665000 400ms cosine\noff 400ms cosine\noff 900ms none\nrepeat\n'],
]);

export function render(readings, alert = Alert.NONE) {
  if (alert !== Alert.NONE) {
    if (!alertPrograms.has(alert)) throw new RangeError('Unknown SidePulse alert');
    return alertPrograms.get(alert);
  }
  const lines = ['off'];
  let hasProgress = false;
  for (const { key, rgb } of gauges) {
    const percent = readings[key];
    if (percent === null || (key === 'disk' && percent === undefined)) continue;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new RangeError('Expected a display percentage from 0 to 100 or null');
    }
    const filled = percent * segments / 100;
    const colors = [];
    for (let index = 0; index < filled; index++) {
      const fraction = Math.min(1, filled - index);
      colors.push('#' + rgb.map(channel => Math.round(channel * fraction).toString(16).padStart(2, '0')).join(''));
    }
    if (!colors.length) {
      lines.push('off 900ms none');
      continue;
    }
    hasProgress = true;
    if (key === 'disk') {
      // A single unindexed color would light the whole strip.
      lines.push(`${colors.length === 1 ? '0:' : ''}${colors.join(' ')} cosine`);
    } else {
      lines.push(colors.map((color, index) => {
        const delay = index === 0 ? '' : ` ${index * 65}ms`;
        return `${index}:${color}${quotaRise} cosine${delay}`;
      }).join(';'));
    }
    lines.push('off 350ms cosine 900ms');
  }
  if (!hasProgress) return 'off\n';
  const program = [...lines, 'repeat', ''].join('\n');
  // Use the firmware's default 330 ms rise only when explicit timing exceeds its byte limit.
  return program.length <= programLimit ? program : program.replaceAll(quotaRise, '');
}

export function createPresenter(findTarget = findSidePulseVolume, now = () => performance.now()) {
  let applied;
  let lastKeepAlive;
  return async (readings, alert = Alert.NONE) => {
    const program = render(readings, alert);
    const { claude, codex, disk } = readings;
    const key = alert === Alert.NONE ? JSON.stringify([claude, codex, disk == null ? null : Math.round(disk)]) : alert;
    try {
      const target = await findTarget();
      if (!target) throw new Error('No usable SidePulse volume');
      const { path, mounted, led } = target;
      if (!lastKeepAlive || !sameFile(mounted, lastKeepAlive.mounted) || now() - lastKeepAlive.at >= 60_000) {
        await keepAlive(path, mounted);
        lastKeepAlive = { mounted, at: now() };
      }
      // Writing LEDS.LED restarts the parser at line 1 even if its bytes are unchanged.
      if (!applied || !sameFile(mounted, applied.mounted) || !sameFile(led, applied.led)
          || (program !== applied.program && key !== applied.key)) {
        await writeLED(path, mounted, program, led);
        applied = { program, key, mounted, led };
      }
    } catch (error) {
      applied = undefined;
      throw error;
    }
  };
}

export const present = createPresenter();

export async function findSidePulseVolume(override = process.env.SIDEPULSE_VOLUME, inspect = inspectVolume) {
  for (const path of override === undefined ? defaultVolumes : [override]) {
    if (!/^\/Volumes\/[^/\0]+$/.test(path) || path.endsWith('/.') || path.endsWith('/..')) return null;
    try {
      return await inspect(path);
    } catch {
      // Missing, unmounted, or not a SidePulse volume.
    }
  }
  return null;
}

async function inspectVolume(path) {
  const mounted = await mountedVolume(path);
  return { path, mounted, led: await ledFile(join(path, 'LEDS.LED'), mounted) };
}

export async function mountedVolume(path) {
  const [parent, entry] = await Promise.all([lstat(dirname(path)), lstat(path)]);
  if (!parent.isDirectory() || !entry.isDirectory() || entry.dev === parent.dev || !await fatMount(path)) {
    throw new Error('Not the SidePulse FAT mount');
  }
  return entry;
}

async function fatMount(path) {
  const { stdout } = await exec('/sbin/mount', ['-t', 'msdos'], { timeout: 1000, killSignal: 'SIGKILL' });
  return stdout.split('\n').some(line => line.match(/^\/dev\/disk\d+(?:s\d+)* on (.+) \(msdos(?:,|\))/)?.[1] === path);
}

async function ledFile(filePath, mounted) {
  const file = await lstat(filePath);
  if (!file.isFile() || file.dev !== mounted.dev) throw new Error('Not the SidePulse LED file');
  return file;
}

export async function writeLED(path, mounted, program, before) {
  const filePath = join(path, 'LEDS.LED');
  before ??= await ledFile(filePath, mounted);
  const fd = await open(filePath, constants.O_WRONLY | fileFlags);
  try {
    const [opened, named, current] = await Promise.all([fd.stat(), ledFile(filePath, mounted), lstat(path)]);
    if (!opened.isFile() || !sameFile(opened, before)
        || !sameFile(opened, named) || !sameFile(current, mounted)) throw new Error('SidePulse mount changed');
    const bytes = Buffer.from(program);
    for (let offset = 0; offset < bytes.length;) {
      const { bytesWritten } = await fd.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error('Short LED write');
      offset += bytesWritten;
    }
    await fd.truncate(bytes.length);
    await fd.sync();
  } finally {
    await fd.close();
  }
}

async function keepAlive(path, mounted) {
  // Anchor creation to the verified mount so an eject cannot redirect it to a fallback directory.
  const cwd = process.cwd();
  let fd;
  process.chdir(path);
  try {
    if (!sameFile(await lstat('.'), mounted)) throw new Error('SidePulse mount changed');
    try {
      fd = await open('keepalive', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | fileFlags, 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      fd = await open('keepalive', constants.O_WRONLY | fileFlags);
    }
    const [opened, named] = await Promise.all([fd.stat(), lstat('keepalive')]);
    if (!opened.isFile() || opened.dev !== mounted.dev || !sameFile(opened, named)) {
      throw new Error('Not the SidePulse keepalive file');
    }
    const now = new Date();
    await fd.utimes(now, now);
    await fd.sync();
  } finally {
    process.chdir(cwd);
    await fd?.close();
  }
}
