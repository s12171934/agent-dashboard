const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function bridge() {
  const source = fs.readFileSync(path.join(__dirname, '../../frontend/app.js'), 'utf8');
  const start = source.indexOf('let mdPipVideo = null;');
  const end = source.indexOf('// half folded', source.indexOf('function mdPip(video)', start));
  assert.ok(start >= 0 && end > start);
  const messages = [];
  const window = { adashApp: 'ios', webkit: { messageHandlers: { adash: { postMessage: m => messages.push(m.pip) } } } };
  const context = vm.createContext({ window, Date });
  vm.runInContext(source.slice(start, end), context);
  return { attach: vm.runInContext('mdPip', context), window, messages };
}

class Video extends EventTarget {
  isConnected = true;
  paused = true;
  ended = false;
  currentTime = 12;
  currentSrc = 'https://fixture.test/video.mp4';
  playbackRate = 1.5;
  getBoundingClientRect() { return { x: 0, y: 0, width: 390, height: 220 }; }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
}

test('PiP bridge sends playback position and speed and hands playback back to the same video', async () => {
  const b = bridge(), video = new Video();
  b.attach(video);
  await video.play();
  assert.equal(b.messages.at(-1).playing, true);
  assert.equal(b.messages.at(-1).t, 12);
  assert.equal(b.messages.at(-1).rate, 1.5);
  b.window.adashPip('start');
  assert.equal(video.paused, true);
  b.window.adashPip('stop', 30, true);
  assert.equal(video.currentTime, 30);
  assert.equal(video.paused, false);
});

test('leaving a recording clears native PiP and ignores late events from its old video', async () => {
  const b = bridge(), video = new Video(), dispose = b.attach(video);
  await video.play();
  dispose();
  assert.equal(b.messages.at(-1).src, '');
  const count = b.messages.length;
  video.pause();
  video.dispatchEvent(new Event('seeked'));
  b.window.adashPip('stop', 90, true);
  dispose();
  assert.equal(b.messages.length, count);
  assert.equal(video.currentTime, 12);
  assert.equal(video.paused, true);
});

test('a stale recording cleanup cannot clear or resume the newly selected recording', async () => {
  const b = bridge(), old = new Video(), dispose = b.attach(old), current = new Video();
  b.attach(current);
  await current.play();
  const count = b.messages.length;
  dispose();
  assert.equal(b.messages.length, count);
  b.window.adashPip('start');
  assert.equal(current.paused, true);
  b.window.adashPip('stop', 42, true);
  assert.equal(current.currentTime, 42);
  assert.equal(old.currentTime, 12);
});
