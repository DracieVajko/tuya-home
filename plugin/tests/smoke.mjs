/*
 * Smoke test for the Tuya Home plugin brain.
 * Loads main.js in a vm sandbox with a fake `cindy`, fake `/kv` and a fake Tuya
 * cloud, then drives tool-calls end to end. Run: node tests/smoke.mjs
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const brainSource = readFileSync(path.join(here, '..', 'main.js'), 'utf8');

const DC = {
  cn: 'https://openapi.tuyacn.com',
  'us-w': 'https://openapi.tuyaus.com',
  'eu-c': 'https://openapi.tuyaeu.com',
  in: 'https://openapi.tuyain.com',
  'us-e': 'https://openapi-ueaz.tuyaus.com',
  'eu-w': 'https://openapi-weaz.tuyaeu.com',
  sg: 'https://openapi-sg.iotbing.com'
};

const LIGHT = 'dev_light_0001';
const AC = 'dev_ac_000002';

const lightModel = {
  modelId: 'light-model',
  services: [{
    properties: [
      { code: 'switch_led', name: 'Switch', accessMode: 'rw', typeSpec: { type: 'bool' } },
      { code: 'bright_value', name: 'Brightness', accessMode: 'rw', typeSpec: { type: 'value', min: 10, max: 1000, scale: 0, step: 1 } },
      { code: 'work_mode', name: 'Mode', accessMode: 'rw', typeSpec: { type: 'enum', range: ['white', 'colour', 'scene'] } },
      { code: 'status_only', name: 'Status', accessMode: 'ro', typeSpec: { type: 'bool' } }
    ]
  }]
};

const acModel = {
  modelId: 'ac-model',
  services: [{
    properties: [
      { code: 'switch', name: 'Power', accessMode: 'rw', typeSpec: { type: 'bool' } },
      { code: 'temp_value', name: 'Temperature', accessMode: 'rw', typeSpec: { type: 'value', min: 160, max: 300, scale: 1, step: 1, unit: '°C' } }
    ]
  }]
};

function makeCloud(state, opts) {
  const calls = [];
  const o = opts || {};

  const fetchImpl = async function (request) {
    calls.push({ url: request.url, method: request.method || 'GET', body: request.body });

    const url = request.url;
    const ok = (result) => ({ ok: true, status: 200, headers: {}, body: JSON.stringify({ success: true, result }) });
    const fail = (code, msg, status = 200) => ({ ok: true, status, headers: {}, body: JSON.stringify({ success: false, code, msg }) });

    if (url === DC.cn + '/v1.0/end-user/homes/all') return fail(1108, 'key belongs to another data centre');
    if (url === DC['us-w'] + '/v1.0/end-user/homes/all') {
      return ok({ homes: [{ home_id: 'home-1', name: 'Flat' }] });
    }
    if (url === DC['us-w'] + '/v1.0/end-user/homes/home-1/rooms') {
      if ((request.method || 'GET') === 'POST') {
        return o.denyRoomCreate ? fail(1010, 'token invalid') : fail(404, 'no such endpoint');
      }
      return ok({ rooms: [{ room_id: 'room-1', name: 'Living Room' }, { room_id: 'room-2', name: 'Bedroom' }] });
    }
    if (url === DC['us-w'] + '/v1.0/end-user/homes/home-1/devices') {
      return ok({
        devices: [
          { device_id: LIGHT, name: 'Ceiling Light', category: 'dj', category_name: 'Light Source', online: true, room_id: 'room-1' },
          { device_id: AC, name: 'Bedroom AC', category: 'kt', category_name: 'Air Conditioner', online: false, room_id: 'room-2' }
        ]
      });
    }
    if (url === DC['us-w'] + '/v1.0/end-user/devices/' + LIGHT + '/detail') {
      return ok({ device_id: LIGHT, name: 'Ceiling Light', online: true, category_name: 'Light Source', properties: state.light });
    }
    if (url === DC['us-w'] + '/v1.0/end-user/devices/' + AC + '/detail') {
      return ok({ device_id: AC, name: 'Bedroom AC', online: false, category_name: 'Air Conditioner', properties: state.ac });
    }
    if (url === DC['us-w'] + '/v1.0/end-user/devices/' + LIGHT + '/model') {
      return ok({ model: JSON.stringify(lightModel) });
    }
    if (url === DC['us-w'] + '/v1.0/end-user/devices/' + AC + '/model') {
      return ok({ model: JSON.stringify(acModel) });
    }
    if (url === DC['us-w'] + '/v1.0/end-user/devices/' + LIGHT + '/shadow/properties/issue') {
      const parsed = JSON.parse(request.body);
      return ok({ accepted: parsed.properties });
    }
    if (url === DC['us-w'] + '/v1.0/end-user/devices/' + LIGHT + '/attribute') {
      return ok({ renamed: JSON.parse(request.body).name });
    }
    if (url === DC['us-w'] + '/v1.0/homes/home-1/room') {
      if (o.denyRoomCreate) return fail(1010, 'token invalid');
      return ok({ room_id: 'room-9' });
    }
    if (url === DC['us-w'] + '/v1.0/homes/home-1/rooms/room-2/devices') {
      return ok({});
    }
    if (url === DC['us-w'] + '/v1.0/devices/' + LIGHT) {
      return ok({});
    }
    if (url === DC['us-w'] + '/v1.0/devices/' + AC) {
      return fail(1106, 'no permission to manage this home');
    }

    return fail(404, 'no such fake endpoint: ' + url);
  };

  return { fetchImpl, calls };
}

function boot(cloud) {
  const toolCalls = [];
  let handler = null;
  /* Tools that need the advanced gate are exercised with it open; a test
   * that wants the default-off behaviour flips it back to false. */
  const kv = { data: { advancedStructure: true } };
  const posted = [];

  const context = {
    cindy: {
      onHostMessage(fn) { handler = fn; },
      send(message) { toolCalls.push(message); if (message.type === 'tool-result') lastResult = message; },
      fetch(request) { return cloud(request); }
    },
    fetch: async (route, init) => {
      if (route !== '/kv') throw new Error('unexpected local fetch: ' + route);
      if (!init || (init.method || 'GET') === 'GET') {
        return { ok: true, status: 200, json: async () => kv.data };
      }
      kv.data = JSON.parse(init.body);
      return { ok: true, status: 204, json: async () => ({}) };
    },
    BroadcastChannel: class {
      constructor(name) { this.name = name; posted.push(this); }
      postMessage(message) { this.last = message; }
    },
    console
  };

  let lastResult = null;

  vm.createContext(context);
  vm.runInContext(brainSource, context, { filename: 'main.js' });

  assert.equal(typeof handler, 'function', 'brain registered a host message handler');

  async function callTool(tool, args, callId) {
    lastResult = null;
    await handler({ type: 'tool-call', tool, args, callId: callId || 'call-' + Math.random().toString(36).slice(2) });
    assert.ok(lastResult, 'tool ' + tool + ' produced a tool-result');
    return lastResult;
  }

  return { callTool, kv, channels: posted, get lastResult() { return lastResult; } };
}

const state = {
  light: { switch_led: true, bright_value: 500, work_mode: 'white', status_only: false },
  ac: { switch: true, temp_value: 220 }
};

const cloud = makeCloud(state);
const harness = boot(cloud.fetchImpl);

// 1. Data-centre discovery: cn rejects the key, us-w answers.
const list = await harness.callTool('list_devices', {}, 'call-list');
assert.equal(list.ok, true, 'list_devices succeeded: ' + list.message);
assert.equal(list.result.count, 2);
assert.match(list.result.summary, /Living Room/);
assert.match(list.result.summary, /Bedroom AC/);
assert.match(list.result.summary, /offline/);
assert.equal(harness.kv.data.baseHost, DC['us-w'], 'working data centre remembered');
console.log('ok  list_devices + data-centre discovery');

// 2. Scaled read: raw 220 with scale 1 is 22 degrees (the fixture range is 160-300).
const ac = await harness.callTool('get_device', { device_id: AC });
assert.equal(ac.ok, true, 'get_device succeeded: ' + ac.message);
assert.equal(ac.result.state.temp_value, 22, 'temperature scaled to real units');
assert.equal(ac.result.online, false);
const tempSpec = ac.result.writable.find((p) => p.code === 'temp_value');
assert.equal(tempSpec.min, 16);
assert.equal(tempSpec.max, 30);
console.log('ok  get_device scaling and range metadata');

// 3. Valid write: half of a 10-1000 light is 500, posted raw with the documented body shape.
const set = await harness.callTool('set_device', { device_id: LIGHT, properties: { bright_value: 500, switch_led: false } });
assert.equal(set.ok, true, 'set_device succeeded: ' + set.message);
const issueCall = [...cloud.calls].reverse().find((c) => c.url.endsWith('/issue'));
const issueBody = JSON.parse(issueCall.body);
assert.equal(typeof issueBody.properties, 'string', 'properties is a JSON string per the Tuya contract');
assert.deepEqual(JSON.parse(issueBody.properties), { bright_value: 500, switch_led: false });
console.log('ok  set_device converts to raw scale and posts the documented body');

// 4. Rejections happen locally, before any network write.
const before = cloud.calls.length;
const badCode = await harness.callTool('set_device', { device_id: LIGHT, properties: { nonsense: true } });
assert.equal(badCode.ok, false);
assert.equal(badCode.errorCode, 'INVALID_PROPERTY');
/* The envelope documents hint as its own field, so the guidance lives there. */
assert.match(badCode.hint, /switch_led/);
assert.match(badCode.message, /no property "nonsense"/);
console.log('ok  unknown property rejected with the writable list');

const readOnly = await harness.callTool('set_device', { device_id: LIGHT, properties: { status_only: true } });
assert.equal(readOnly.errorCode, 'READ_ONLY');
console.log('ok  read-only property rejected');

const outOfRange = await harness.callTool('set_device', { device_id: AC, properties: { temp_value: 99 } });
assert.equal(outOfRange.errorCode, 'OUT_OF_RANGE');
assert.match(outOfRange.message, /16 and 30/);
console.log('ok  out-of-range value rejected with the real limit');

const badEnum = await harness.callTool('set_device', { device_id: LIGHT, properties: { work_mode: 'warm' } });
assert.equal(badEnum.errorCode, 'INVALID_VALUE');
assert.match(badEnum.hint, /white \| colour \| scene/);
console.log('ok  enum rejected with allowed values');

const writesDuringRejects = cloud.calls.slice(before).filter((c) => c.url.endsWith('/issue')).length;
assert.equal(writesDuringRejects, 0, 'no write reached the cloud while validating');
console.log('ok  validation never touched the device');

// 5. Bad device id is caught before any request.
const badId = await harness.callTool('get_device', { device_id: '../../etc' });
assert.equal(badId.errorCode, 'INVALID_DEVICE');
console.log('ok  malformed device id rejected');

// 6. Rename.
const renamed = await harness.callTool('rename_device', { device_id: LIGHT, name: 'Desk Lamp' });
assert.equal(renamed.ok, true, 'rename succeeded: ' + renamed.message);
console.log('ok  rename_device');

// 7. Unknown tool is refused rather than silently ignored.
const unknown = await harness.callTool('delete_everything', {});
assert.equal(unknown.ok, false);
assert.equal(unknown.errorCode, 'UNKNOWN_TOOL');
console.log('ok  unknown tool refused');

// 8. Request economy: with the host verified and the model cached, one write is one request.
const beforeWrite = cloud.calls.length;
const warmWrite = await harness.callTool('set_device', { device_id: LIGHT, properties: { work_mode: 'colour' } });
assert.equal(warmWrite.ok, true, 'warm write succeeded: ' + warmWrite.message);
const delta = cloud.calls.length - beforeWrite;
assert.equal(delta, 1, 'a warm set_device costs exactly one request, got ' + delta);
console.log('ok  warm write costs one request (rate-limit friendly)');

// 9. A host burst cap (the "4 concurrent requests" rejection) is a local
//    refusal, not a verdict on the key: it must be retried, and discovery must
//    continue to the remaining data centres.
{
  const CAP = '同时进行的网络请求已达上限(4),请等在途请求返回';
  let capped = 0;
  const flaky = async function (request) {
    const url = request.url;
    const ok = (result) => ({ ok: true, status: 200, headers: {}, body: JSON.stringify({ success: true, result }) });
    if (url === DC.cn + '/v1.0/end-user/homes/all') {
      capped++;
      return { ok: false, status: 0, errorCode: 'NETWORK', message: CAP };
    }
    if (url === DC['us-w'] + '/v1.0/end-user/homes/all') return ok({ homes: [{ home_id: 'home-1', name: 'Flat' }] });
    if (url.endsWith('/rooms')) return ok({ rooms: [] });
    if (url.endsWith('/devices')) return ok({ devices: [] });
    return ok({});
  };
  const h = boot(flaky);
  const r = await h.callTool('list_devices', {}, 'call-flaky');
  assert.equal(r.ok, true, 'burst cap is retried instead of being fatal: ' + r.message);
  assert.equal(h.kv.data.baseHost, DC['us-w'], 'discovery continued past the capped centre');
  assert.equal(capped, 2, 'the capped centre was attempted twice, got ' + capped);
  console.log('ok  host burst cap is retried and discovery continues');
}

// 10. If nothing answers at all, say so honestly: a network problem must not be
//     reported as a rejected key, or the user is sent to change the wrong setting.
{
  const CAP = '同时进行的网络请求已达上限(4),请等在途请求返回';
  const dead = async function () {
    return { ok: false, status: 0, errorCode: 'NETWORK', message: CAP };
  };
  const h = boot(dead);
  const r = await h.callTool('tuya_status', {}, 'call-dead');
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'NETWORK', 'reported as a network failure, got ' + r.errorCode);
  assert.doesNotMatch(r.message, /accepted the key/, 'must not blame the key: ' + r.message);
  assert.match(r.hint, /network problem, not a rejected key/);
  console.log('ok  total network failure reported as network, not a rejected key');
}

// 11. A genuinely rejected key still gets the data-centre explanation.
{
  const rejecting = async function () {
    return { ok: true, status: 200, headers: {}, body: JSON.stringify({ success: false, code: 1108, msg: 'key belongs to another data centre' }) };
  };
  const h = boot(rejecting);
  const r = await h.callTool('tuya_status', {}, 'call-reject');
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'NO_DATACENTRE');
  assert.match(r.message, /Tried 7 of 7/);
  console.log('ok  all centres answering with a rejection stays NO_DATACENTRE');
}

// 12. tuya_status already reports the home count inside `summary`. The settings
//     panel renders that summary verbatim, so it must not append the count a
//     second time (the user saw "1 home(s) visible to this key." twice).
{
  const ok = async function () {
    return { ok: true, status: 200, headers: {}, body: JSON.stringify({ success: true, result: [{ homeId: 'home_1', name: 'Flat' }] }) };
  };
  const h = boot(ok);
  const r = await h.callTool('tuya_status', {}, 'call-summary');
  assert.equal(r.ok, true, 'tuya_status succeeded: ' + r.message);
  const hits = (r.result.summary.match(/home\(s\) visible to this key/g) || []).length;
  assert.equal(hits, 1, 'summary states the home count exactly once, got ' + hits);

  const settingsSource = readFileSync(path.join(here, '..', 'settings.js'), 'utf8');
  /* Normalise first: the old bug split the append across two source lines. */
  const flat = settingsSource.replace(/\s+/g, ' ');
  const doubled = /status\.summary[^;]{0,300}home\(s\) visible/.test(flat);
  assert.equal(doubled, false, 'settings.js must not append the home count to a value that already carries it');
  console.log('ok  home count stated once, settings panel does not double the summary');
}


// 13. Rooms: create once, then recognise the same room instead of duplicating it.
{
  const h = boot(makeCloud(state).fetchImpl);
  const made = await h.callTool('create_room', { name: 'Kitchen' }, 'call-room');
  assert.equal(made.ok, true, 'create_room succeeded: ' + made.message);
  assert.equal(made.result.created, true);
  assert.equal(made.result.room_id, 'room-9');
  assert.equal(made.result.api, 'smart-home', 'fell back to the documented path: ' + made.result.api);

  const again = await h.callTool('create_room', { name: 'living room' }, 'call-room-dup');
  assert.equal(again.result.created, false, 'existing room is not created twice');
  assert.equal(again.result.room_id, 'room-1');

  const blank = await h.callTool('create_room', { name: '   ' }, 'call-room-blank');
  assert.equal(blank.ok, false);
  assert.equal(blank.errorCode, 'INVALID_VALUE');
  console.log('ok  create_room is idempotent by name and refuses a blank name');
}

// 14. Assigning a device to a room posts the documented device_ids body.
{
  const c = makeCloud(state);
  const h = boot(c.fetchImpl);
  const moved = await h.callTool('assign_device_room', { device_id: LIGHT, room_id: 'room-2' }, 'call-move');
  assert.equal(moved.ok, true, 'assign_device_room succeeded: ' + moved.message);
  assert.equal(moved.result.room_name, 'Bedroom');
  const post = c.calls.filter(function (x) { return x.method === 'POST' && x.url.endsWith('/rooms/room-2/devices'); });
  assert.equal(post.length, 1, 'one assignment request');
  assert.deepEqual(JSON.parse(post[0].body), { device_ids: [LIGHT] });

  const bogus = await h.callTool('assign_device_room', { device_id: LIGHT, room_id: 'room-404' }, 'call-move-bad');
  assert.equal(bogus.ok, false);
  assert.equal(bogus.errorCode, 'ROOM_NOT_FOUND');
  assert.match(bogus.message, /No room room-404/);
  console.log('ok  assign_device_room posts device_ids and refuses an unknown room');
}

// 15. Removal is destructive: refuse without a repeated id, and never let a
//     shared display name stand in for the id.
{
  const c = makeCloud(state);
  const h = boot(c.fetchImpl);

  const noConfirm = await h.callTool('remove_device', { device_id: LIGHT }, 'call-del-noconfirm');
  assert.equal(noConfirm.ok, false);
  assert.equal(noConfirm.errorCode, 'CONFIRMATION_REQUIRED');
  let deletes = c.calls.filter(function (x) { return (x.method || 'GET') === 'DELETE'; });
  assert.equal(deletes.length, 0, 'no DELETE was sent without confirmation');

  const wrong = await h.callTool('remove_device', { device_id: LIGHT, confirm_device_id: AC }, 'call-del-wrong');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.errorCode, 'CONFIRMATION_REQUIRED', 'a different id is not a confirmation');

  const gone = await h.callTool('remove_device', { device_id: LIGHT, confirm_device_id: LIGHT }, 'call-del');
  assert.equal(gone.ok, true, 'remove_device succeeded: ' + gone.message);
  assert.equal(gone.result.device_id, LIGHT);
  deletes = c.calls.filter(function (x) { return (x.method || 'GET') === 'DELETE'; });
  assert.equal(deletes.length, 1, 'exactly one DELETE, for the confirmed device');
  assert.ok(deletes[0].url.endsWith('/v1.0/devices/' + LIGHT), 'delete hit the confirmed id: ' + deletes[0].url);
  console.log('ok  remove_device requires the id twice and deletes only that id');
}

// 16. When the key cannot manage the home, say exactly that: home-management
//     calls are not end-user reads, and the Tuya app is then the honest answer.
{
  const h = boot(makeCloud(state).fetchImpl);
  const refused = await h.callTool('remove_device', { device_id: AC, confirm_device_id: AC }, 'call-del-denied');
  assert.equal(refused.ok, false, 'a permission refusal is not reported as success');
  assert.match(refused.message, /1106/);
  assert.match(refused.hint, /home-structure call/, 'the hint explains the call family: ' + refused.hint);
  console.log('ok  home-management refusal is reported as a permission limit, not a success');
}

// 17. When neither family accepts the key, report both attempts and never
//     pretend the room exists. A healthy key must not be called expired.
{
  const h = boot(makeCloud(state, { denyRoomCreate: true }).fetchImpl);
  const r = await h.callTool('create_room', { name: 'Kitchen' }, 'call-room-denied');
  assert.equal(r.ok, false, 'a refusal is not reported as a created room');
  assert.equal(r.errorCode, 'CREATE_ROOM_FAILED');
  assert.match(r.message, /end-user ->/, 'the end-user attempt is listed: ' + r.message);
  assert.match(r.message, /smart-home ->/, 'the smart-home attempt is listed: ' + r.message);
  assert.match(r.message, /1010/);
  assert.doesNotMatch(r.message, /Create a new key/, 'a working key is not sent to be replaced');
  assert.match(r.message, /Tuya refused to create the room/);
  assert.match(r.hint, /Neither room endpoint accepted the key/);
  console.log('ok  refused room creation lists both attempts and does not blame an expired key');
}

// 18. Off by default: with the gate closed the advanced tools refuse locally,
//     send nothing to Tuya, and tell the model to stop rather than retry.
{
  const c = makeCloud(state);
  const h = boot(c.fetchImpl);
  h.kv.data.advancedStructure = false;

  for (const [tool, args] of [
    ['create_room', { name: 'Kitchen' }],
    ['assign_device_room', { device_id: LIGHT, room_id: 'room-1' }],
    ['remove_device', { device_id: LIGHT, confirm_device_id: LIGHT }]
  ]) {
    const r = await h.callTool(tool, args, 'call-gate-' + tool);
    assert.equal(r.ok, false, tool + ' must refuse with the gate closed');
    assert.equal(r.errorCode, 'ADVANCED_REQUIRED', tool + ' refused locally, got ' + r.errorCode);
    assert.match(r.hint, /Do not retry/, tool + ' tells the model to stop');
  }
  assert.equal(c.calls.length, 0, 'the gate closed before any request left: ' + c.calls.length);

  /* The read tools are unaffected by the gate. */
  const listed = await h.callTool('list_devices', {}, 'call-gate-read');
  assert.equal(listed.ok, true, 'list_devices still works with the gate closed');
  console.log('ok  advanced tools refuse locally when off, reads keep working');
}


// 17. Numeric home ids: Tuya sometimes answers with numbers, and a filter that
//     compares with === returned "no devices" for a home that exists.
{
  const numericHomes = async function (request) {
    const url = request.url;
    const ok = (result) => ({ ok: true, status: 200, headers: {}, body: JSON.stringify({ success: true, result }) });
    if (url.endsWith('/v1.0/end-user/homes/all')) return ok({ homes: [{ homeId: 1, name: 'Flat' }] });
    if (url.endsWith('/homes/1/rooms')) return ok({ rooms: [{ roomId: 7, name: 'Hall' }] });
    if (url.endsWith('/homes/1/devices')) return ok({ devices: [{ device_id: LIGHT, name: 'Lamp', category: 'dj', online: true, room_id: 7 }] });
    if (url.endsWith('/model')) return ok(lightModel);
    return ok({});
  };
  const h = boot(numericHomes);
  const byHomeString = await h.callTool('list_devices', { home_id: '1' }, 'call-num-home');
  assert.equal(byHomeString.ok, true, 'list_devices with a string home id succeeded: ' + byHomeString.message);
  assert.equal(byHomeString.result.count, 1, 'string "1" matches numeric home 1');
  const byRoomString = await h.callTool('list_devices', { room_id: '7' }, 'call-num-room');
  assert.equal(byRoomString.result.count, 1, 'string "7" matches numeric room 7');
  const byHomeNumber = await h.callTool('list_devices', { home_id: 1 }, 'call-num-home-2');
  assert.equal(byHomeNumber.result.count, 1, 'numeric 1 matches numeric home 1');
  console.log('ok  numeric and string home/room ids match');
}

// 18. tuya_status advertises one spelling per fact: no alias fields, one
//     success flag and a real home count.
{
  const ok = async function () {
    return { ok: true, status: 200, headers: {}, body: JSON.stringify({ success: true, result: [{ homeId: 'home_1', name: 'Flat' }] }) };
  };
  const h = boot(ok);
  const r = await h.callTool('tuya_status', {}, 'call-status-shape');
  assert.equal(r.ok, true, 'tuya_status succeeded');
  const status = r.result;
  for (const alias of ['base_host', 'host', 'data_centre', 'data_center', 'home_count']) {
    assert.equal(alias in status, false, 'tuya_status must not return the alias ' + alias);
  }
  assert.equal(typeof status.homes_visible, 'number', 'homes_visible is a count');
  assert.equal('homes' in status, false, 'a count and a list never share a field name');
  assert.equal(status.ok, true, 'one success flag');
  console.log('ok  tuya_status returns one spelling per fact');
}

// 19. The panel toggle goes through the same device-id guard as a tool call.
{
  const h = boot(makeCloud(state).fetchImpl);
  const channel = h.channels[0];
  assert.ok(channel && typeof channel.onmessage === 'function', 'panel handler registered');
  channel.onmessage({ data: { type: 'panel-request', reqId: 'p1', action: 'toggle', device_id: '../../etc' } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(channel.last, 'panel got a reply');
  assert.equal(channel.last.ok, false, 'malformed id is refused');
  assert.equal(channel.last.errorCode, 'INVALID_DEVICE', 'panel toggle validates device_id, got ' + channel.last.errorCode);
  console.log('ok  panel toggle validates device_id');
}

console.log('\nall smoke checks passed');
