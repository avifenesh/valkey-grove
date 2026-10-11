import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {hashSlot, ownerOf} from '../dist/slots.js';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]*\n/, '');

// Exercise the real app handlers without starting animation or polling timers.
function app() {
  const elements = new Map();
  const ink = new Proxy({}, {get: (_, name) => name === 'createRadialGradient'
    ? () => ({addColorStop() {}}) : () => {}});
  function element(id) {
    return {
      id, hidden: false, value: '', textContent: '', style: {}, dataset: {}, attributes: new Map(),
      listeners: new Map(), classList: {add() {}, remove() {}, toggle() {}},
      append() {}, replaceChildren() {}, setAttribute(name, value) {this.attributes.set(name, value);}, setPointerCapture() {},
      addEventListener(name, listener) {this.listeners.set(name, listener);},
      getContext: () => ink,
      getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 700}),
      click() {this.onclick?.();}, showModal() {}, close() {},
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
    createElement: element, createTextNode: textContent => ({textContent}),
    querySelectorAll: () => [], documentElement: {dataset: {}}, hidden: false,
  };
  let resolveFetch, rejectFetch;
  const sandbox = {
    document, hashSlot, ownerOf, location: {hostname: '127.0.0.1'},
    matchMedia: () => ({matches: false}), localStorage: {getItem: () => null},
    ResizeObserver: class {constructor(callback) {this.callback = callback;} observe() {this.callback();}},
    requestAnimationFrame() {}, setInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: () => new Promise((resolve, reject) => {resolveFetch = resolve; rejectFetch = reject;}),
    AbortSignal, URL, Blob, Date, TextEncoder, devicePixelRatio: 1,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    elements,
    evaluate: code => vm.runInContext(code, sandbox),
    async open(snapshot) {
      await elements.get('snapshot-file').onchange({target: {
        files: [{text: async () => JSON.stringify(snapshot)}], value: 'snapshot.json',
      }});
    },
    resolve(snapshot) {
      resolveFetch({headers: {get: () => 'application/json'}, ok: true, json: async () => snapshot});
    },
    reject(error) {rejectFetch(error);},
  };
}

function snapshot(keys) {
  return {
    nodes: [{id: 'node', address: '127.0.0.1:7400', slots: [[0, 16383]], keys: keys.length}],
    keys, capturedAt: '2026-10-12T12:00:00Z', complete: true,
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('imported snapshot survives pending live success and failure', async () => {
  for (const outcome of ['success', 'failure']) {
    const view = app();
    await view.open(snapshot([{name: 'saved:key', node: 0}]));
    if (outcome === 'success') view.resolve(snapshot([{name: 'live:key', node: 0}]));
    else view.reject(Error('Connection lost'));
    await settle();
    assert.equal(view.evaluate('data.keys[0].name'), 'saved:key', outcome);
    assert.equal(view.evaluate('live'), false);
    assert.match(view.elements.get('last-updated').textContent, /^SNAPSHOT /);
    assert.equal(view.elements.get('refresh').disabled, false);
  }
});

test('binary dot keeps its identity despite a colliding text label and refresh', async () => {
  const view = app();
  const literal = {name: '[binary] /w==', node: 0, slot: hashSlot('[binary] /w==')};
  const binary = {name: '/w==', node: 0, slot: 7920, encoding: 'base64'};
  await view.open(snapshot([literal, binary]));
  const position = view.evaluate('point(dots[1].x, dots[1].y)');
  view.elements.get('grove').listeners.get('pointerup')({clientX: position.x, clientY: position.y});
  assert.equal(view.evaluate('focus.slot'), 7920);
  assert.equal(view.evaluate('focus.key.encoding'), 'base64');

  await view.open(snapshot([binary, literal]));
  assert.equal(view.evaluate('focus.slot'), 7920);
  assert.equal(view.evaluate('focus.key.encoding'), 'base64');

  view.elements.get('key-search').value = literal.name;
  view.elements.get('search-form').listeners.get('submit')({preventDefault() {}});
  assert.equal(view.evaluate('focus.slot'), literal.slot);
  assert.equal(view.evaluate('focus.key.encoding'), undefined);

  view.evaluate('locate(keyLabel(data.keys[0]), true, data.keys[0])');
  await view.open(snapshot([literal]));
  assert.equal(view.evaluate('focus'), null);
  assert.equal(view.elements.get('inspector').hidden, true);
});

test('formations preserve key identity through projected clicks and refresh', async () => {
  const view = app();
  const key = {name: 'garden:{tenant}:leaf', node: 0, slot: hashSlot('garden:{tenant}:leaf')};
  const original = snapshot([key]);
  await view.open(original);
  const positions = [];
  for (const name of ['canopy', 'bloom', 'spiral']) {
    view.elements.get('show-all').onclick();
    view.elements.get('formation-' + name).onclick();
    assert.equal(view.elements.get('formation-' + name).attributes.get('aria-pressed'), 'true');
    assert.equal(view.evaluate('data.keys[0].slot'), key.slot);
    const position = view.evaluate('point(dots[0].x, dots[0].y)');
    positions.push(JSON.stringify(position));
    view.elements.get('grove').listeners.get('pointerup')({clientX: position.x, clientY: position.y});
    assert.equal(view.evaluate('focus.key.name'), key.name);
    assert.equal(view.evaluate('focus.slot'), key.slot);
    await view.open(original);
    assert.equal(view.evaluate('formation'), name);
    assert.equal(view.evaluate('focus.key.name'), key.name);
  }
  assert.equal(new Set(positions).size, 3, 'each formation has a distinct projection');
});
