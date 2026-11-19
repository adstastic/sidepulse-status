import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPresenter, findSidePulseVolume, mountedVolume, render, writeLED } from './device.mjs';

const wasm = new WebAssembly.Module(await readFile(new URL('./sdled.wasm', import.meta.url)));
const dark = '000000';
const claude = 'd97757';
const codex = '397dff';
const disk = '35d05a';
const black = Array(8).fill(dark);
const unavailable = { claude: null, codex: null };

function playback(program) {
  const bytes = Buffer.from(program);
  assert.ok(bytes.length <= 512);
  assert.ok(program.replace(/\n$/, '').split('\n').length <= 20);
  const { exports: fw } = new WebAssembly.Instance(wasm);
  const memory = new Uint8Array(fw.memory.buffer);
  fw.sdled_reset(8, 0);
  memory.set(bytes, fw.sdled_input_ptr());
  assert.equal(fw.sdled_parse(8, bytes.length, 0), 1, program);
  let time = 0;
  return ms => {
    for (; time <= ms; time += 10) fw.sdled_step(8, time);
    return Array.from({ length: 8 }, (_, index) => {
      const at = fw.sdled_output_ptr() + index * 3;
      return Buffer.from(memory.subarray(at, at + 3)).toString('hex');
    });
  };
}

test('full gauges fit the format limits and rise from LED 0 with overlapping ramps', () => {
  const frame = playback(render({ claude: 100, codex: 100 }));
  for (const [start, color] of [[0, claude], [1950, codex]]) {
    const first = frame(start + 40);
    assert.ok(first[0] > dark && first[0] < color);
    assert.deepEqual(first.slice(1), black.slice(1));
    const overlap = frame(start + 120);
    assert.ok(overlap[0] > first[0] && overlap[0] < color);
    assert.ok(overlap[1] > dark && overlap[1] < overlap[0]);
    assert.deepEqual(overlap.slice(2), black.slice(2));
    const full = Array(8).fill(color);
    assert.deepEqual(frame(start + 730), full);
    assert.deepEqual(frame(start + 1520), full);
    assert.ok(frame(start + 1760).every(pixel => pixel > dark && pixel < color));
  }
  assert.deepEqual(frame(4650), Array(8).fill(claude));
});

test('three full gauges fit the format and play orange, blue, green in order', () => {
  const frame = playback(render({ claude: 100, codex: 100, disk: 100 }));
  const turns = [];
  for (let ms = 0; ms < 11_000; ms += 10) {
    const pixels = frame(ms);
    const color = pixels[0];
    if ([claude, codex, disk].includes(color) && pixels.every(pixel => pixel === color) && color !== turns.at(-1)) {
      turns.push(color);
    }
  }
  assert.deepEqual(turns.slice(0, 4), [claude, codex, disk, claude]);
});

test('disk plays third and shows a fractional fill with the unused LEDs dark', () => {
  const frame = playback(render({ claude: 50, codex: 50, disk: 2.27 }));
  assert.deepEqual(frame(500), [...Array(4).fill(claude), ...black.slice(4)]);
  assert.deepEqual(frame(2200), [...Array(4).fill(codex), ...black.slice(4)]);
  let reachedDisk = false;
  let fadedIn = false;
  for (let ms = 2210; ms < 5200; ms += 10) {
    const pixels = frame(ms);
    const [red, green, blue] = Buffer.from(pixels[0], 'hex');
    if (green <= red || green <= blue) continue;
    assert.deepEqual(pixels.slice(1), black.slice(1));
    if (!reachedDisk && green < 0x26) fadedIn = true;
    if (pixels[0] === '0a2610') reachedDisk = true;
  }
  assert.ok(fadedIn && reachedDisk);
  assert.deepEqual(playback(render({ ...unavailable, disk: 56.25 }))(500),
    [disk, disk, disk, disk, '1b682d', dark, dark, dark]);
});

test('unavailable disk skips its turn and zero free space displays no green', () => {
  const reading = { claude: 100, codex: 100 };
  assert.equal(render({ ...reading, disk: null }), render(reading));
  assert.deepEqual(playback(render({ claude: null, codex: null, disk: 0 }))(1000), black);
});

test('normal WASM playback repeats orange once, then blue once', () => {
  const frame = playback(render({ claude: 100, codex: 100 }));
  const turns = [];
  let previous;
  for (let ms = 0; ms < 11700; ms += 10) {
    const [pixel] = frame(ms);
    const red = pixel.slice(0, 2);
    const blue = pixel.slice(4);
    const color = red > blue ? 'orange' : red < blue ? 'blue' : null;
    if (color && color !== previous) turns.push(color);
    previous = color;
  }
  assert.ok(turns.length >= 6);
  assert.deepEqual(turns, turns.map((_, index) => index % 2 === 0 ? 'orange' : 'blue'));
});

test('both gauges keep LEDs 4 through 7 off throughout playback at 50%', () => {
  const frame = playback(render({ claude: 50, codex: 50 }));
  for (let ms = 0; ms <= 4000; ms += 10) {
    const pixels = frame(ms);
    assert.deepEqual(pixels.slice(4), black.slice(4), `at ${ms}ms`);
    if (ms === 500) assert.deepEqual(pixels.slice(0, 4), Array(4).fill(claude));
    if (ms === 2200) assert.deepEqual(pixels.slice(0, 4), Array(4).fill(codex));
  }
});

test('missing gauges do not take a turn', () => {
  for (const [quota, color] of [
    [{ claude: 50, codex: null }, claude],
    [{ claude: null, codex: 50 }, codex],
  ]) {
    const frame = playback(render(quota));
    const pixels = [...Array(4).fill(color), ...black.slice(4)];
    assert.deepEqual(frame(500), pixels);
    assert.deepEqual(frame(2200), pixels);
  }
});

test('0% is black and fractional segments glow only at the leading edge', () => {
  for (const quota of [unavailable, { claude: 0, codex: null }, { claude: null, codex: 0 }, { claude: 0, codex: 0 }]) {
    assert.deepEqual(playback(render(quota))(5000), black);
  }
  const zeroThenBlue = playback(render({ claude: 0, codex: 56.25 }));
  assert.deepEqual(zeroThenBlue(500), black);
  assert.deepEqual(zeroThenBlue(1500), [codex, codex, codex, codex, '1d3f80', dark, dark, dark]);
  const orangeThenZero = playback(render({ claude: 56.25, codex: 0 }));
  assert.deepEqual(orangeThenZero(600), [claude, claude, claude, claude, '6d3c2c', dark, dark, dark]);
  assert.deepEqual(orangeThenZero(2300), black);
});

test('invalid input is not displayed as quota', () => {
  for (const percent of [undefined, '50', NaN, Infinity, -1, 101]) {
    assert.throws(() => render({ claude: percent, codex: null }), RangeError);
    assert.throws(() => render({ claude: null, codex: percent }), RangeError);
  }
});

test('red alarm flashes the full strip twice with at most two flashes in any second', () => {
  const frame = playback(render({ claude: 100, codex: 100, disk: 100 }, 'battery'));
  const red = Array(8).fill('b00000');
  const starts = [];
  let wasLit = false;
  for (let ms = 0; ms < 4440; ms += 10) {
    const phase = ms % 1480;
    const pixels = frame(ms);
    assert.deepEqual(pixels, phase < 140 || (phase >= 340 && phase < 480) ? red : black, `at ${ms}ms`);
    const lit = pixels[0] !== dark;
    if (lit && !wasLit) starts.push(ms);
    wasLit = lit;
  }
  assert.ok(starts.slice(2).every((ms, index) => ms - starts[index] >= 1000));
});

test('yellow attention pulse is soft, single, and replaces the gauges', () => {
  const frame = playback(render({ claude: 100, codex: 100, disk: 100 }, 'attention'));
  const yellow = '665000';
  for (const start of [0, 1700, 3400]) {
    assert.deepEqual(frame(start), black);
    for (let offset = 100; offset < 800; offset += 100) {
      const pixels = frame(start + offset);
      if (offset === 400) assert.deepEqual(pixels, Array(8).fill(yellow));
      else assert.ok(pixels.every(pixel => pixel > dark && pixel < yellow && pixel.endsWith('00')));
    }
    for (let offset = 800; offset < 1700; offset += 10) {
      assert.deepEqual(frame(start + offset), black, `at ${start + offset}ms`);
    }
  }
});

async function fixture(t) {
  const dir = await mkdtemp(fileURLToPath(new URL('./.gauge-test-', import.meta.url)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, mounted: await lstat(dir), led: join(dir, 'LEDS.LED') };
}

test('deduplicates quota and alert programs and touches keepalive at most once per minute', async t => {
  const { dir, mounted, led } = await fixture(t);
  let elapsed = 0;
  const show = createPresenter(async () => ({ path: dir, mounted, led: await lstat(led) }), () => elapsed);
  const quota = { claude: 50, codex: 50 };
  const keepalive = join(dir, 'keepalive');
  await writeFile(led, 'old program');
  await show(quota);
  const program = await readFile(led, 'utf8');
  assert.equal(program, render(quota));
  const earlier = new Date('2000-01-01T00:00:00Z');
  await utimes(led, earlier, earlier);
  const { mtimeMs } = await lstat(led);

  await show({ ...quota });
  assert.equal((await lstat(led)).mtimeMs, mtimeMs, 'LEDS.LED was rewritten');
  assert.equal(await readFile(led, 'utf8'), program);
  assert.equal(await readFile(keepalive, 'utf8'), '');
  await writeFile(keepalive, 'untouched');
  await utimes(keepalive, earlier, earlier);
  await show(quota, 'battery');
  assert.equal(await readFile(led, 'utf8'), render(quota, 'battery'));
  assert.notEqual(await readFile(led, 'utf8'), program);
  await utimes(led, earlier, earlier);
  elapsed = 59_999;
  await show(unavailable, 'battery');
  assert.equal((await lstat(keepalive)).mtimeMs, +earlier);
  assert.equal((await lstat(led)).mtimeMs, mtimeMs);
  elapsed = 60_000;
  await show(quota, 'battery');
  assert.ok((await lstat(keepalive)).mtimeMs > +earlier);
  assert.equal(await readFile(keepalive, 'utf8'), 'untouched');
  assert.equal((await lstat(led)).mtimeMs, mtimeMs);

  await show(unavailable);
  assert.equal(await readFile(led, 'utf8'), 'off\n');
});

test('disk changes restart playback only when the rounded percentage changes', async t => {
  const { dir, mounted, led } = await fixture(t);
  const show = createPresenter(async () => ({ path: dir, mounted, led: await lstat(led) }));
  const reading = { claude: 50, codex: 50, disk: 2.27 };
  await writeFile(led, 'off\n');
  await show(reading);
  const program = await readFile(led, 'utf8');
  const earlier = new Date('2000-01-01T00:00:00Z');
  await utimes(led, earlier, earlier);

  await show({ ...reading, disk: 2.48 });
  assert.equal((await lstat(led)).mtimeMs, +earlier);
  assert.equal(await readFile(led, 'utf8'), program);

  await show({ ...reading, disk: 2.72 });
  const updated = await readFile(led, 'utf8');
  assert.notEqual(updated, program);
  assert.ok((await lstat(led)).mtimeMs > +earlier);
  await show({ ...reading, disk: null });
  assert.notEqual(await readFile(led, 'utf8'), updated);
});

test('reapplies quota after mount failure and when a different mount appears', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  let current = first;
  const show = createPresenter(async () => current && ({
    path: current.dir, mounted: current.mounted, led: await lstat(current.led),
  }));
  const quota = { claude: 50, codex: 50 };
  await writeFile(first.led, 'off\n');
  await show(quota);

  current = undefined;
  await assert.rejects(show(quota), /No usable SidePulse volume/);
  await writeFile(first.led, 'off\n');
  current = first;
  await show(quota);
  assert.equal(await readFile(first.led, 'utf8'), render(quota));

  await writeFile(second.led, 'off\n');
  current = second;
  await show(quota);
  assert.equal(await readFile(second.led, 'utf8'), render(quota));
});

test('overwrites in place and truncates when quota becomes unavailable', async t => {
  const { dir, mounted, led } = await fixture(t);
  await writeFile(led, 'old program');
  const { ino } = await lstat(led);
  const full = render({ claude: 100, codex: 100 });
  await writeLED(dir, mounted, full);
  assert.equal(await readFile(led, 'utf8'), full);
  await writeLED(dir, mounted, render(unavailable));
  assert.equal(await readFile(led, 'utf8'), 'off\n');
  assert.equal((await lstat(led)).ino, ino);
});

test('rejects a fallback directory, missing file, and symlink without writing', async t => {
  const { dir, mounted, led } = await fixture(t);
  await assert.rejects(mountedVolume(dir), /FAT mount/);
  await assert.rejects(writeLED(dir, mounted, render(unavailable)), { code: 'ENOENT' });
  await assert.rejects(lstat(led), { code: 'ENOENT' });
  const target = join(dir, 'target');
  await writeFile(target, 'untouched');
  await symlink(target, led);
  await assert.rejects(writeLED(dir, mounted, render(unavailable)));
  assert.equal(await readFile(target, 'utf8'), 'untouched');
});

test('tries only the supported default volumes and prefers SidePulse when both are ready', async () => {
  const sidePulse = { path: '/Volumes/SidePulse' };
  const pro = { path: '/Volumes/SidePulsePro' };
  const inspect = (...volumes) => async path => {
    const volume = volumes.find(volume => volume.path === path);
    if (!volume) throw new Error('Not a SidePulse mount');
    return volume;
  };
  assert.equal(await findSidePulseVolume(undefined, inspect(sidePulse, pro)), sidePulse);
  assert.equal(await findSidePulseVolume(undefined, inspect(pro)), pro);
  assert.equal(await findSidePulseVolume(undefined, inspect({ path: '/Volumes/Other' })), null);
});

test('an explicit volume is exclusive and cannot traverse outside a direct /Volumes child', async () => {
  const device = { path: '/Volumes/Custom Device' };
  const inspect = async path => {
    if (path !== device.path) throw new Error('Volume unavailable');
    return device;
  };
  assert.equal(await findSidePulseVolume(device.path, inspect), device);
  const anyVolume = async path => ({ path });
  for (const path of ['', 'SidePulse', '/tmp/SidePulse', '/Volumes', '/Volumes/.', '/Volumes/..',
    '/Volumes/../SidePulse', '/Volumes//SidePulse', '/Volumes/SidePulse/', '/Volumes/SidePulse/nested']) {
    assert.equal(await findSidePulseVolume(path, anyVolume), null);
  }
  const tries = [];
  assert.equal(await findSidePulseVolume(device.path, async path => {
    tries.push(path);
    if (path === '/Volumes/SidePulse') return { path };
    throw new Error('Volume unavailable');
  }), null);
  assert.deepEqual(tries, [device.path]);
});

test('rejects a changed mount without modifying the file', async t => {
  const { dir, led } = await fixture(t);
  const { mounted: previousMount } = await fixture(t);
  await writeFile(led, 'untouched');
  await assert.rejects(writeLED(dir, previousMount, render(unavailable)), /mount changed/);
  assert.equal(await readFile(led, 'utf8'), 'untouched');
});
