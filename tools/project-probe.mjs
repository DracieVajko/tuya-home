/*
 * Feasibility probe for Tuya *project* credentials (Access ID / Access Secret).
 *
 * The plugin's end-user key (sk-...) cannot create rooms or unbind devices:
 * Tuya answers 1108 (path) on the end-user family and 1010 (token) on the
 * Smart Home family. Project credentials are the documented route, but whether
 * a *linked consumer app account* may change home structure is an open
 * question. This script answers it with the smallest possible call.
 *
 * Credentials are read from tools/.env (gitignored) or the environment. They
 * are never printed, and the access token is never printed: only status codes,
 * Tuya error codes and room names come out.
 *
 * Read-only by default. Creating a room needs an explicit flag:
 *
 *   node tools/project-probe.mjs
 *   node tools/project-probe.mjs --create-room="Test room"
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

function loadEnv() {
  const file = path.join(here, '.env');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (_) {
    return { source: 'none' };
  }
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return { source: file, values: out };
}

const env = loadEnv();
const pick = (name) => process.env[name] || (env.values && env.values[name]) || '';

const CLIENT_ID = pick('TUYA_CLIENT_ID');
const CLIENT_SECRET = pick('TUYA_CLIENT_SECRET');
const HOME_ID = pick('TUYA_HOME_ID');
const BASE = (pick('TUYA_BASE') || 'https://openapi.tuyaeu.com').replace(/\/+$/, '');

const missing = [];
if (!CLIENT_ID) missing.push('TUYA_CLIENT_ID');
if (!CLIENT_SECRET) missing.push('TUYA_CLIENT_SECRET');
if (!HOME_ID) missing.push('TUYA_HOME_ID');
if (missing.length) {
  console.error('Missing: ' + missing.join(', '));
  console.error('Fill them into ' + path.join(here, '.env') + ' (that file is gitignored).');
  console.error('Format, one per line: TUYA_CLIENT_ID=... TUYA_CLIENT_SECRET=... TUYA_HOME_ID=123456789');
  process.exit(2);
}

const sha256 = (value) => createHash('sha256').update(value || '', 'utf8').digest('hex');
const hmac = (value, secret) => createHmac('sha256', secret).update(value, 'utf8').digest('hex').toUpperCase();

/* stringToSign = METHOD \n sha256(body) \n headers \n url, per Tuya's Sign Requests doc.
 * Token calls sign client_id + t + nonce + stringToSign; business calls insert
 * access_token after client_id. */
function signTokenRequest(method, urlPath) {
  const t = String(Date.now());
  const nonce = randomUUID().replace(/-/g, '');
  const stringToSign = method + '\n' + sha256('') + '\n' + '\n' + urlPath;
  const sign = hmac(CLIENT_ID + t + nonce + stringToSign, CLIENT_SECRET);
  return { client_id: CLIENT_ID, sign, t, sign_method: 'HMAC-SHA256', nonce };
}

function signBusinessRequest(method, urlPath, body, accessToken) {
  const t = String(Date.now());
  const nonce = randomUUID().replace(/-/g, '');
  const stringToSign = method + '\n' + sha256(body === undefined ? '' : body) + '\n' + '\n' + urlPath;
  const sign = hmac(CLIENT_ID + accessToken + t + nonce + stringToSign, CLIENT_SECRET);
  return {
    client_id: CLIENT_ID,
    access_token: accessToken,
    sign,
    t,
    sign_method: 'HMAC-SHA256',
    nonce
  };
}

async function call(method, urlPath, opts) {
  const o = opts || {};
  const headers = o.token
    ? signBusinessRequest(method, urlPath, o.body, o.token)
    : signTokenRequest(method, urlPath);
  const init = {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
  };
  if (o.body !== undefined) init.body = o.body;

  const response = await fetch(BASE + urlPath, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return { http: response.status, parsed: false, raw: text.slice(0, 300) };
  }
  return { http: response.status, parsed: true, body: json };
}

function describe(label, result) {
  if (!result.parsed) {
    console.log(label + ': HTTP ' + result.http + ', non-JSON body: ' + result.raw);
    return;
  }
  const b = result.body;
  if (b && b.success === true) {
    console.log(label + ': success');
    return;
  }
  console.log(label + ': HTTP ' + result.http + ', code ' + (b && b.code) + ' — ' + (b && b.msg));
}

console.log('Base: ' + BASE);
console.log('Home: ' + HOME_ID);
console.log('Credentials loaded from: ' + (env.source === 'none' ? 'environment' : 'tools/.env'));

const tokenResult = await call('GET', '/v1.0/token?grant_type=1');
describe('project token', tokenResult);
const accessToken = tokenResult.parsed && tokenResult.body && tokenResult.body.success
  ? tokenResult.body.result.access_token
  : null;
if (!accessToken) {
  console.log('');
  console.log('No project token, so nothing else can be tried. Check Access ID / Secret and the data centre host.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const flagValues = (name) => argv.filter((a) => a.startsWith('--' + name + '=')).map((a) => a.slice(name.length + 3));

const wantsRooms = argv.includes('--rooms');
const createMany = flagValues('create-rooms').join('|');
const createOne = flagValues('create-room');
const assigns = flagValues('assign');
const removeOne = flagValues('remove-device');

let roomsNow = [];

async function loadRooms() {
  const res = await call('GET', '/v1.0/homes/' + encodeURIComponent(HOME_ID) + '/rooms', { token: accessToken });
  if (!(res.parsed && res.body && res.body.success)) {
    describe('read rooms', res);
    return [];
  }
  const list = (res.body.result && res.body.result.rooms) || res.body.result || [];
  roomsNow = Array.isArray(list) ? list.map((r) => ({ id: String(r.room_id), name: r.name })) : [];
  return roomsNow;
}

await loadRooms();

if (wantsRooms) {
  console.log('');
  console.log('Rooms now:');
  if (!roomsNow.length) console.log('  (none)');
  for (const r of roomsNow) console.log('  ' + r.id + '  ' + r.name);
}

const toCreate = createOne.concat(createMany ? createMany.split('|') : []).map((n) => n.trim()).filter(Boolean);

for (const name of toCreate) {
  const existing = roomsNow.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    console.log('room "' + name + '" already exists (' + existing.id + ')');
    continue;
  }
  const res = await call('POST', '/v1.0/homes/' + encodeURIComponent(HOME_ID) + '/room', {
    token: accessToken,
    body: JSON.stringify({ name })
  });
  if (res.parsed && res.body && res.body.success) {
    console.log('created room "' + name + '"');
  } else {
    describe('create room "' + name + '"', res);
  }
  await loadRooms();
}

if (toCreate.length) {
  console.log('');
  console.log('Rooms after creating:');
  for (const r of roomsNow) console.log('  ' + r.id + '  ' + r.name);
}

for (const spec of assigns) {
  const sep = spec.indexOf(':');
  if (sep < 1) {
    console.log('bad --assign "' + spec + '", expected ROOM_ID:device_id[,device_id]');
    continue;
  }
  const roomKey = spec.slice(0, sep).trim();
  const devices = spec.slice(sep + 1).split(',').map((d) => d.trim()).filter(Boolean);
  const room = roomsNow.find((r) => r.id === roomKey) ||
    roomsNow.find((r) => r.name.toLowerCase() === roomKey.toLowerCase());
  if (!room) {
    console.log('no room matching "' + roomKey + '"');
    continue;
  }
  const res = await call('POST', '/v1.0/homes/' + encodeURIComponent(HOME_ID) + '/rooms/' + encodeURIComponent(room.id) + '/devices', {
    token: accessToken,
    body: JSON.stringify({ device_ids: devices })
  });
  if (res.parsed && res.body && res.body.success) {
    console.log('assigned ' + devices.length + ' device(s) to "' + room.name + '" (' + room.id + ')');
  } else {
    describe('assign to "' + room.name + '"', res);
  }
}

for (const id of removeOne) {
  const res = await call('DELETE', '/v1.0/devices/' + encodeURIComponent(id), { token: accessToken });
  if (res.parsed && res.body && res.body.success) {
    console.log('removed device ' + id);
  } else {
    describe('remove device ' + id, res);
  }
}

if (!wantsRooms && !toCreate.length && !assigns.length && !removeOne.length) {
  console.log('');
  console.log('Nothing changed. Flags: --rooms, --create-room="Name", --create-rooms="A|B", --assign=ROOM_ID:dev1,dev2, --remove-device=ID');
}
