/*
 * Tuya Home — Cindy plugin brain.
 *
 * Data path: this sandbox -> cindy.fetch -> Tuya end-user REST API.
 * The API key never enters this file: the host injects it as
 * `Authorization: Bearer <key>` for the declared hosts only.
 *
 * No WebSocket here: cindy.fetch cannot stream, so live state is read on demand
 * and the panel refreshes explicitly. See README for the why.
 */

const PLUGIN_ID = 'tuya-home';
const CHANNEL = 'tuya-home';
const CACHE_MS = 20000;
const MODEL_TTL_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 20000;
// The host caps concurrent requests (and Tuya rate limits bursts). A rejection
// there says nothing about the key, so retry it briefly instead of reporting it
// as a bad key or an unknown data centre.
const RETRY_DELAYS_MS = [400, 1000];
const MAX_DEVICES_IN_SNAPSHOT = 250;
const SUMMARY_ITEMS = 24;

// Tuya routes every end-user call to the data centre the account lives in.
// The API key prefix says which one, but the plugin never sees the key value,
// so we discover the working host once and remember it.
const DATA_CENTRES = [
  { region: 'cn', base: 'https://openapi.tuyacn.com' },
  { region: 'us-w', base: 'https://openapi.tuyaus.com' },
  { region: 'eu-c', base: 'https://openapi.tuyaeu.com' },
  { region: 'in', base: 'https://openapi.tuyain.com' },
  { region: 'us-e', base: 'https://openapi-ueaz.tuyaus.com' },
  { region: 'eu-w', base: 'https://openapi-weaz.tuyaeu.com' },
  { region: 'sg', base: 'https://openapi-sg.iotbing.com' }
];

const RESERVED_HOST_CODES = new Set([
  'GHOST_NOT_FOUND', 'GHOST_NAMESPACE_MISMATCH', 'GHOST_ASLEEP',
  'GHOST_CRASHED', 'TIMEOUT', 'INTERNAL'
]);

/**
 * @typedef {Object} Device
 * @property {string} device_id
 * @property {string} name
 * @property {string} category vendor category code
 * @property {string} category_name human label when Tuya supplies one
 * @property {boolean} online
 * @property {string|null} room_id
 * @property {string|null} room_name
 * @property {string} [home_id] set only for devices read per home
 */

/**
 * @typedef {Object} Room
 * @property {string|undefined} room_id
 * @property {string} name
 */

/**
 * @typedef {Object} Home
 * @property {string|undefined} home_id
 * @property {string} name
 * @property {Room[]} rooms
 */

/**
 * @typedef {Object} Snapshot
 * @property {number} at epoch ms when it was read
 * @property {Home[]} homes
 * @property {Device[]} devices every device the key can see
 * @property {number} device_total
 * @property {string[]} warnings reads that failed while building it
 */

/**
 * @typedef {Object} PropertyDescriptor
 * @property {string} code
 * @property {string} name
 * @property {string} type Tuya type name, or "unknown" when the spec omits it
 * @property {string} accepts what the user may send
 * @property {boolean} [unsupported] true when the type cannot be written here
 * @property {string[]} [range] enum values, when the type is enum
 * @property {number} [max_length] string limit
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {string} [unit]
 */

/**
 * @typedef {Object} ToolResult
 * @property {true} ok
 * @property {string} summary what happened, in one readable block
 * @property {string} [device_id]
 * @property {string} [hint]
 * Tool-specific fields (device_id, count, devices, ...) sit at the top level.
 */

/**
 * @typedef {Object} DeviceRead
 * @property {string} device_id
 * @property {string} name
 * @property {boolean} online
 * @property {string} category vendor category code
 * @property {string} category_name display label
 * @property {Record<string, *>} state scaled where Tuya gives a scale; structs and arrays pass through
 * @property {PropertyDescriptor[]} writable
 */

class TuyaError extends Error {
  /**
   * @param {string} code stable error code from docs/INSTALL.md
   * @param {string} message what happened
   * @param {string} [hint] what to do next
   * @param {{transient?: boolean, ambiguous?: boolean}} [flags] retry metadata:
   *   transient means a retry may help, ambiguous means the write may have
   *   landed and must not be replayed
   */
  constructor(code, message, hint, flags) {
    super(message);
    this.name = 'TuyaError';
    this.code = RESERVED_HOST_CODES.has(code) ? 'INTERNAL' : code;
    this.hint = hint || '';
    this.transient = !!(flags && flags.transient);
    this.ambiguous = !!(flags && flags.ambiguous);
  }
}

/* ------------------------------------------------------------------ kv --- */

async function kvGet() {
  try {
    const r = await fetch('/kv');
    if (!r.ok) return {};
    const v = await r.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

async function kvPatch(patch) {
  const current = await kvGet();
  const next = Object.assign({ schema: 1 }, current, patch);
  try {
    await fetch('/kv', { method: 'PUT', body: JSON.stringify(next) });
  } catch (_) {
    /* kv is a convenience cache here, never the source of truth */
  }
  return next;
}

/* --------------------------------------------------------------- tuya --- */

function sleep(ms) {
  return new Promise(function (resolve) {
    // The sandbox may not expose timers; retrying without a pause is still
    // better than dropping a transient failure on the floor.
    if (typeof setTimeout === 'function') setTimeout(resolve, ms);
    else resolve();
  });
}

function isTransient(err) {
  if (!(err instanceof TuyaError)) return false;
  // A timeout is ambiguous: the write may have landed, so it is never retried.
  if (err.ambiguous === true) return false;
  // A host rejection means the request never left, so even a write is safe to
  // repeat. BAD_RESPONSE and SERVER set the same flag.
  if (err.transient === true) return true;
  return err.code === 'NETWORK' || err.code === 'RATE_LIMITED';
}

async function withRetry(fn, attempts) {
  const max = Math.max(1, attempts || 1);
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === max - 1 || !isTransient(err)) throw err;
      await sleep(RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)]);
    }
  }
}

async function rawCall(base, path, opts) {
  const o = opts || {};
  const req = {
    url: base + path,
    method: o.method || 'GET',
    timeoutMs: o.timeoutMs || CALL_TIMEOUT_MS
  };
  if (o.body !== undefined) {
    req.body = JSON.stringify(o.body);
    req.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  } else {
    req.headers = { Accept: 'application/json' };
  }
  if (o.callId) req.callId = o.callId;

  /* Only reads may be retried. A rejected or garbled write may already have
   * landed, so a retry is the caller's decision, not ours. */
  const isRead = (o.method || 'GET') === 'GET';
  const attempts = o.attempts || (isRead ? 3 : 1);

  return withRetry(async function () {
    const res = await cindy.fetch(req);
    if (!res || res.ok !== true) {
      // The host refused the request locally: it never reached Tuya. That is a
      // burst cap or an offline machine, never a verdict on the key.
      const message = (res && res.message) || 'Network request failed';
      throw new TuyaError(
        'NETWORK',
        message,
        'The request did not reach Tuya. Wait a few seconds and try again; if it repeats, check that this computer is online.',
        { transient: true, ambiguous: !!(res && res.errorCode === 'TIMEOUT') }
      );
    }

    let body;
    try {
      body = JSON.parse(res.body);
    } catch (_) {
      throw new TuyaError(
        'BAD_RESPONSE',
        'Tuya answered with a non-JSON body (HTTP ' + res.status + ').',
        'This usually means the request never reached the Tuya API. Retry once; if it repeats, check the data centre in the plugin settings.',
        { transient: true }
      );
    }

    if (body && body.success === true) return body.result;

    const apiCode = body && body.code;
    const apiMsg = (body && body.msg) || 'Tuya rejected the request';
    throw errorForApiCode(apiCode, apiMsg, res.status);
  }, attempts);
}

function errorForApiCode(apiCode, apiMsg, httpStatus) {
  const detail = 'Tuya error ' + (apiCode === undefined ? httpStatus : apiCode) + ': ' + apiMsg;
  if (httpStatus === 429 || apiCode === 429) {
    return new TuyaError(
      'RATE_LIMITED',
      detail,
      'The end-user API is rate limited. Wait a minute before trying again, and avoid bulk loops over devices.'
    );
  }
  if (typeof httpStatus === 'number' && httpStatus >= 500) {
    return new TuyaError(
      'SERVER',
      detail,
      'Tuya had a server-side failure. Retry in a moment.',
      { transient: true }
    );
  }
  if (apiCode === 1010) {
    return new TuyaError(
      'AUTH',
      detail,
      'The API key has expired. Create a new key and replace it in the plugin settings.'
    );
  }
  if (apiCode === 1004 || apiCode === 1108 || apiCode === 1013) {
    return new TuyaError(
      'AUTH',
      detail,
      'The key was rejected. Most often it belongs to a different data centre than the account: open the plugin settings and set the data centre explicitly.'
    );
  }
  return new TuyaError('API_ERROR', detail, '');
}

let verifiedBase = null;
/* The centre probe already read the home list; tuya_status reuses that answer
 * for a few seconds instead of asking Tuya again. */
let probeHomes = { at: 0, base: null, value: null };

let baseInflight = null;

async function resolveBase(callId) {
  if (baseInflight) return baseInflight;
  baseInflight = resolveBaseUncached(callId).finally(function () {
    baseInflight = null;
  });
  return baseInflight;
}

async function resolveBaseUncached(callId) {
  const kv = await kvGet();

  if (kv.baseOverride) {
    const forced = DATA_CENTRES.find(function (d) { return d.region === kv.baseOverride; });
    if (forced) {
      verifiedBase = forced.base;
      return forced.base;
    }
  }

  // A host that answered earlier in this session stays trusted: re-probing on
  // every call would triple the request count against a rate-limited API.
  if (kv.baseHost && kv.baseHost === verifiedBase) return kv.baseHost;

  if (kv.baseHost && DATA_CENTRES.some(function (d) { return d.base === kv.baseHost; })) {
    try {
      await rawCall(kv.baseHost, '/v1.0/end-user/homes/all', { callId: callId });
      verifiedBase = kv.baseHost;
      return kv.baseHost;
    } catch (err) {
      if (!(err instanceof TuyaError) || err.code !== 'NETWORK') throw err;
    }
  }

  const tried = [];
  let answered = 0;
  let timedOut = 0;
  let lastTransient = null;

  for (const dc of DATA_CENTRES) {
    try {
      const probed = await rawCall(dc.base, '/v1.0/end-user/homes/all', {
        callId: callId,
        timeoutMs: PROBE_TIMEOUT_MS,
        attempts: 2
      });
      probeHomes = { at: Date.now(), base: dc.base, value: probed };
      await kvPatch({ baseHost: dc.base, baseRegion: dc.region, probedAt: Date.now() });
      verifiedBase = dc.base;
      return dc.base;
    } catch (err) {
      tried.push(dc.region + ': ' + err.message);
      // A transient failure (host burst cap, timeout, 5xx) is not evidence about
      // the key, so keep probing the remaining centres instead of giving up on
      // the first one and blaming the data centre setting.
      if (isTransient(err)) {
        lastTransient = err;
        timedOut += 1;
      } else {
        answered += 1;
      }
    }
  }

  if (answered === 0 && lastTransient) {
    throw new TuyaError(
      'NETWORK',
      'Could not get an answer from any Tuya data centre. Tried ' + tried.length + ' of ' + DATA_CENTRES.length + '. ' + tried.slice(0, 2).join(' | '),
      'This is a network problem, not a rejected key: the request was blocked or timed out before Tuya answered. Wait a few seconds, then run the test again, and do not press Test connection repeatedly.'
    );
  }

  const mixed = timedOut > 0;
  throw new TuyaError(
    'NO_DATACENTRE',
    'No Tuya data centre accepted the key. ' + answered + ' rejected it, ' + timedOut + ' did not answer. Tried ' +
      tried.length + ' of ' + DATA_CENTRES.length + '. ' + tried.slice(0, 3).join(' | '),
    mixed
      ? 'Some centres never answered, so this is not proof the key is dead. Run the test again before creating a new key; if it repeats, check your network.'
      : 'Every data centre reached Tuya and rejected the key, so it is probably not valid any more. Create a new key, or set the data centre explicitly if your account sits in a region this list does not cover.'
  );
}

async function tuya(path, opts) {
  const base = await resolveBase(opts && opts.callId);
  return rawCall(base, path, opts);
}

/* ------------------------------------------------------------ shapes --- */

/** Unwrap the list Tuya nests under the named key (or a plain array). */
function asArray(value, key) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return key && Array.isArray(value[key]) ? value[key] : [];
}

function homeIdOf(home) {
  return home && (home.home_id || home.gid || home.homeId || home.id);
}

function roomIdOf(room) {
  return room && (room.room_id || room.roomId || room.id);
}

function deviceIdOf(device) {
  return device && (device.device_id || device.devId || device.id);
}

function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(deviceId)) {
    throw new TuyaError(
      'INVALID_DEVICE',
      'device_id is missing or malformed.',
      'Call list_devices and pass one of the returned device_id values verbatim.'
    );
  }
  return deviceId;
}

/**
 * @param {Object} device raw Tuya device
 * @param {Record<string, string>} roomNames
 * @returns {Device}
 */
function normaliseDevice(device, roomNames) {
  const id = deviceIdOf(device);
  const roomId = device.room_id || device.roomId;
  return {
    device_id: id,
    name: device.name || device.custom_name || id,
    category: device.category || '',
    category_name: device.category_name || device.category || '',
    online: device.online === true,
    room_id: roomId || null,
    room_name: roomId ? roomNames[roomId] || null : null
  };
}

/* ---------------------------------------------------------- snapshot --- */

let snapshotCache = { at: 0, value: null };
let modelCache = new Map();

/** Drop the device snapshot after a write, so the next tool call sees Tuya's
 * state. Device models change rarely, so they stay cached unless a status
 * refresh asks for a full reset. */
function invalidateCache(opts) {
  snapshotCache = { at: 0, value: null };
  /* A read that started before the write must not publish its stale result. */
  snapshotGeneration += 1;
  if (opts && opts.models === true) modelCache = new Map();
}

let snapshotInflight = null;
let snapshotGeneration = 0;

/**
 * @param {{callId?: string, force?: boolean}} [opts]
 * @returns {Promise<Snapshot>}
 */
async function buildSnapshot(opts) {
  const o = opts || {};
  const now = Date.now();
  if (!o.force && snapshotCache.value && now - snapshotCache.at < CACHE_MS) {
    return snapshotCache.value;
  }
  if (snapshotInflight) return snapshotInflight;
  snapshotInflight = readSnapshot(o).finally(function () {
    snapshotInflight = null;
  });
  return snapshotInflight;
}

async function readSnapshot(o) {
  const now = Date.now();
  const generation = snapshotGeneration;
  const homesRaw = await tuya('/v1.0/end-user/homes/all', { callId: o.callId });
  const homes = asArray(homesRaw, 'homes');

  const roomsByHome = {};
  const devices = [];
  const seen = new Set();
  const warnings = [];

  if (homes.length === 0) {
    const devicesRaw = await tuya('/v1.0/end-user/devices/all', { callId: o.callId });
    for (const device of asArray(devicesRaw, 'devices')) {
      const id = deviceIdOf(device);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      devices.push(normaliseDevice(device, {}));
    }
  }

  for (const home of homes) {
    const homeId = homeIdOf(home);
    if (!homeId) continue;  // a home without an id cannot be addressed

    let rooms = [];
    try {
      rooms = asArray(await tuya('/v1.0/end-user/homes/' + encodeURIComponent(homeId) + '/rooms', { callId: o.callId }), 'rooms');
    } catch (err) {
      rooms = [];
      warnings.push('rooms for home ' + homeId + ' could not be read: ' + err.message);
    }
    const roomNames = {};
    for (const room of rooms) {
      const rid = roomIdOf(room);
      if (rid) roomNames[rid] = room.name || rid;
    }
    roomsByHome[homeId] = rooms
      .filter(function (room) { return Boolean(roomIdOf(room)); })
      .map(function (room) {
        const rid = roomIdOf(room);
        return { room_id: rid, name: roomNames[rid] || rid };
      });

    let homeDevices = [];
    try {
      homeDevices = asArray(await tuya('/v1.0/end-user/homes/' + encodeURIComponent(homeId) + '/devices', { callId: o.callId }), 'devices');
    } catch (err) {
      homeDevices = [];
      warnings.push('devices for home ' + homeId + ' could not be read: ' + err.message);
    }
    for (const device of homeDevices) {
      const id = deviceIdOf(device);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const normalised = normaliseDevice(device, roomNames);
      normalised.home_id = homeId;
      devices.push(normalised);
    }
  }

  const snapshot = {
    at: now,
    homes: homes.map(function (home) {
      const homeId = homeIdOf(home);
      return {
        home_id: homeId,
        name: home.name || homeId,
        rooms: roomsByHome[homeId] || []
      };
    }),
    devices: devices,
    device_total: devices.length,
    warnings: warnings
  };

  /* A write may have landed while this read was in flight; if so, do not
   * publish the older result. */
  if (generation === snapshotGeneration) snapshotCache = { at: now, value: snapshot };
  return snapshot;
}

function formatSnapshot(snapshot, opts) {
  const o = opts || {};
  const filtered = o.filtered === true;
  const lines = [];
  const byHome = new Map();
  for (const device of snapshot.devices) {
    const key = device.home_id || '';
    if (!byHome.has(key)) byHome.set(key, []);
    byHome.get(key).push(device);
  }

  for (const home of snapshot.homes) {
    const list = byHome.get(home.home_id) || [];
    if (filtered && list.length === 0) continue;
    lines.push(home.name + ' — ' + list.length + ' device' + (list.length === 1 ? '' : 's'));
    const byRoom = new Map();
    for (const device of list) {
      const key = device.room_name || 'No room';
      if (!byRoom.has(key)) byRoom.set(key, []);
      byRoom.get(key).push(device);
    }
    for (const [roomName, roomDevices] of byRoom) {
      lines.push('  ' + roomName);
      for (const device of roomDevices) {
        lines.push(
          '    - ' + device.name + ' (' + (device.category_name || 'unknown') + ')' +
          (device.online ? '' : ' [offline]') + ' — ' + device.device_id
        );
      }
    }
  }

  const orphaned = byHome.get('') || [];
  if (orphaned.length) {
    lines.push('Not in a home:');
    for (const device of orphaned) {
      lines.push('  - ' + device.name + ' (' + (device.category_name || 'unknown') + ') — ' + device.device_id);
    }
  }

  if (snapshot.devices.length === 0) {
    if (filtered) {
      lines.push('No devices match that home or room filter.');
    } else {
      lines.push(
        snapshot.warnings && snapshot.warnings.length
          ? 'Some parts of this account could not be read, so the list is incomplete.'
          : 'No devices found in this Tuya account.'
      );
    }
  }
  for (const warning of snapshot.warnings || []) {
    lines.push('Note: ' + warning);
  }
  if (!filtered && snapshot.device_total > snapshot.devices.length) {
    lines.push('... ' + (snapshot.device_total - snapshot.devices.length) + ' more devices not listed. Ask the user to narrow by home.');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------- model --- */

async function loadModel(deviceId, callId) {
  const cached = modelCache.get(deviceId);
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.model;

  const path = '/v1.0/end-user/devices/' + encodeURIComponent(deviceId) + '/model';
  let model = null;
  /* A garbled model body is worth one more read: it is transient by nature and
   * this call sits outside the request-level retry. */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await tuya(path, { callId: callId });
    const raw = result && (result.model !== undefined ? result.model : result);
    if (typeof raw !== 'string') {
      model = raw;
      break;
    }
    try {
      model = JSON.parse(raw);
      break;
    } catch (_) {
      if (attempt === 1) {
        throw new TuyaError(
          'BAD_RESPONSE',
          'Tuya returned a device model that could not be parsed.',
          'Retry; if it repeats, open the device in the Tuya app and check it still exists.'
        );
      }
    }
  }
  const empty = !model || typeof model !== 'object' || !Array.isArray(model.services) || model.services.length === 0;
  if (empty) {
    throw new TuyaError(
      'BAD_MODEL',
      'Tuya returned no usable model for this device.',
      'Retry; if it repeats, open the device in the Tuya app and check it still exists.'
    );
  }
  modelCache.set(deviceId, { at: Date.now(), model: model });
  return model;
}

function modelProperties(model) {
  const out = [];
  const services = (model && model.services) || [];
  for (const service of services) {
    for (const property of service.properties || []) {
      out.push(property);
    }
  }
  return out;
}

function scaleOf(spec) {
  return spec && typeof spec.scale === 'number' ? spec.scale : 0;
}

function toReal(raw, scale) {
  return raw / Math.pow(10, scale);
}

function fromRaw(real, scale) {
  return Math.round(real * Math.pow(10, scale));
}

/**
 * @param {Object} property raw Tuya property spec
 * @returns {PropertyDescriptor}
 */
function describeProperty(property) {
  const spec = property.typeSpec || {};
  const scale = scaleOf(spec);
  const desc = {
    code: property.code,
    name: property.name || property.description || property.code,
    type: spec.type || 'unknown'
  };
  if (spec.type === 'bool') {
    desc.accepts = 'true or false';
  } else if (spec.type === 'enum') {
    const values = spec.range || [];
    desc.range = values;
    desc.accepts = values.length ? values.join(' | ') : 'one of the values Tuya reports';
  } else if (spec.type === 'value') {
    desc.min = typeof spec.min === 'number' ? toReal(spec.min, scale) : undefined;
    desc.max = typeof spec.max === 'number' ? toReal(spec.max, scale) : undefined;
    desc.step = typeof spec.step === 'number' ? toReal(spec.step, scale) : undefined;
    desc.unit = spec.unit || '';
    if (desc.min !== undefined && desc.max !== undefined) {
      desc.accepts = 'number from ' + desc.min + ' to ' + desc.max;
    } else if (desc.min !== undefined) {
      desc.accepts = 'number from ' + desc.min;
    } else if (desc.max !== undefined) {
      desc.accepts = 'number up to ' + desc.max;
    } else {
      desc.accepts = 'number';
    }
  } else if (spec.type === 'string') {
    desc.max_length = spec.maxlen;
    desc.accepts = 'text up to ' + (spec.maxlen || 255) + ' characters';
  } else {
    desc.accepts = 'not supported by this plugin (' + spec.type + ')';
    desc.unsupported = true;
  }
  return desc;
}

function humaniseState(model, properties) {
  const specs = new Map();
  for (const property of modelProperties(model)) specs.set(property.code, property);
  const state = {};
  for (const [code, value] of Object.entries(properties || {})) {
    const spec = specs.get(code);
    const typeSpec = (spec && spec.typeSpec) || {};
    if (typeSpec.type === 'value' && typeof value === 'number' && typeSpec.scale) {
      state[code] = toReal(value, scaleOf(typeSpec));
    } else {
      state[code] = value;
    }
  }
  return state;
}

/* ----------------------------------------------------------- control --- */

/**
 * @param {Object} model raw device model
 * @param {Record<string, *>} requested values in real-world units
 * @returns {{raw: Record<string, *>, applied: Record<string, *>}}
 */
function validateProperties(model, requested) {
  const specs = new Map();
  for (const property of modelProperties(model)) specs.set(property.code, property);

  const writable = Array.from(specs.values())
    .filter(function (property) { return property.accessMode !== 'ro'; })
    .map(function (property) { return property.code; });

  const raw = {};
  const applied = {};

  for (const [code, value] of Object.entries(requested)) {
    const spec = specs.get(code);
    if (!spec) {
      throw new TuyaError(
        'INVALID_PROPERTY',
        'This device has no property "' + code + '".',
        'Writable properties are: ' + (writable.length ? writable.join(', ') : '(none)') + '.'
      );
    }
    if (spec.accessMode === 'ro') {
      throw new TuyaError(
        'READ_ONLY',
        '"' + code + '" is read-only on this device.',
        'Writable properties are: ' + (writable.length ? writable.join(', ') : '(none)') + '.'
      );
    }

    const typeSpec = spec.typeSpec || {};
    const scale = scaleOf(typeSpec);

    if (typeSpec.type === 'bool') {
      let boolValue = value;
      if (value === 'true') boolValue = true;
      if (value === 'false') boolValue = false;
      if (typeof boolValue !== 'boolean') {
        throw new TuyaError('INVALID_VALUE', '"' + code + '" needs true or false.', 'Send a JSON boolean.');
      }
      raw[code] = boolValue;
      applied[code] = boolValue;
    } else if (typeSpec.type === 'enum') {
      const range = typeSpec.range || [];
      if (!range.includes(value)) {
        throw new TuyaError(
          'INVALID_VALUE',
          '"' + code + '" does not accept ' + JSON.stringify(value) + '.',
          'Allowed values: ' + range.join(' | ') + '.'
        );
      }
      raw[code] = value;
      applied[code] = value;
    } else if (typeSpec.type === 'value') {
      if (value === null || value === '' || typeof value === 'boolean') {
        throw new TuyaError('INVALID_VALUE', '"' + code + '" needs a number.', 'Send a JSON number in real-world units.');
      }
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) {
        throw new TuyaError('INVALID_VALUE', '"' + code + '" needs a number.', 'Send a JSON number in real-world units.');
      }
      const min = typeof typeSpec.min === 'number' ? toReal(typeSpec.min, scale) : -Infinity;
      const max = typeof typeSpec.max === 'number' ? toReal(typeSpec.max, scale) : Infinity;
      if (number < min || number > max) {
        throw new TuyaError(
          'OUT_OF_RANGE',
          '"' + code + '" must be between ' + min + ' and ' + max + (typeSpec.unit ? ' ' + typeSpec.unit : '') + ', got ' + number + '.',
          'Send a value inside that range.'
        );
      }
      const encoded = fromRaw(number, scale);
      raw[code] = encoded;
      applied[code] = toReal(encoded, scale);
    } else if (typeSpec.type === 'string') {
      const text = String(value);
      const maxlen = typeSpec.maxlen || 255;
      if (text.length === 0 || text.length > maxlen) {
        throw new TuyaError('INVALID_VALUE', '"' + code + '" must be 1 to ' + maxlen + ' characters.', 'Shorten the text.');
      }
      raw[code] = text;
      applied[code] = text;
    } else {
      throw new TuyaError(
        'UNSUPPORTED_TYPE',
        '"' + code + '" uses the Tuya type ' + typeSpec.type + ', which this plugin cannot write.',
        'Use the Tuya app for raw, bitmap, struct and array properties.'
      );
    }
  }

  if (Object.keys(raw).length === 0) {
    throw new TuyaError('INVALID_VALUE', 'No properties to change.', 'Pass at least one property code and value.');
  }
  return { raw: raw, applied: applied };
}

/**
 * @param {string} deviceId
 * @param {string} [callId]
 * @returns {Promise<DeviceRead>}
 */
async function readDevice(deviceId, callId) {
  const detail = await tuya('/v1.0/end-user/devices/' + encodeURIComponent(deviceId) + '/detail', { callId: callId });
  if (!detail) {
    throw new TuyaError(
      'DEVICE_NOT_FOUND',
      'Tuya returned no detail for this device.',
      'The device may have been removed, or the key has no access to it. Call list_devices again.'
    );
  }
  const model = await loadModel(deviceId, callId);
  const properties = modelProperties(model)
    .filter(function (property) { return property.accessMode !== 'ro'; })
    .map(describeProperty)
    .filter(function (property) { return !property.unsupported; });

  let detailProperties = detail.properties || {};
  if (typeof detailProperties === 'string') {
    try {
      detailProperties = JSON.parse(detailProperties);
    } catch (_) {
      detailProperties = {};
    }
  }
  if (!detailProperties || typeof detailProperties !== 'object' || Array.isArray(detailProperties)) {
    detailProperties = {};
  }

  let categoryName = detail.category_name || detail.category || '';
  if (categoryName && categoryName === detail.category && snapshotCache.value) {
    // Tuya returns the category code here and the device list carries the
    // display name. Only a warm cache is consulted: one device read must not
    // trigger a whole-account listing.
    const cached = (snapshotCache.value.devices || []).find(function (d) { return d.device_id === deviceId; });
    if (cached && cached.category_name) categoryName = cached.category_name;
  }

  return {
    device_id: deviceId,
    name: detail.name || detail.custom_name || deviceId,
    online: detail.online === true,
    category: detail.category || '',
    category_name: categoryName,
    state: humaniseState(model, detailProperties),
    writable: properties
  };
}

/* One place sends a property write, so the endpoint and the body shape cannot
 * drift between the toggle button and set_device. */
async function postProperties(deviceId, raw, callId) {
  return tuya('/v1.0/end-user/devices/' + encodeURIComponent(deviceId) + '/shadow/properties/issue', {
    method: 'POST',
    body: { properties: JSON.stringify(raw) },
    callId: callId
  });
}

function findDevice(snapshot, deviceId) {
  const device = (snapshot.devices || []).find(function (d) { return d.device_id === deviceId; });
  if (!device) {
    throw new TuyaError('DEVICE_NOT_FOUND', 'No device ' + deviceId + ' in this account.', 'Call list_devices again.');
  }
  return device;
}

const SWITCH_CODES = ['switch_led', 'switch', 'switch_1', 'switch_1_1'];

function pickSwitchCode(state) {
  for (const code of SWITCH_CODES) {
    if (typeof state[code] === 'boolean') return code;
  }
  return null;
}

async function toggleDevice(deviceId, callId) {
  const device = await readDevice(deviceId, callId);
  if (!device.online) {
    throw new TuyaError('DEVICE_OFFLINE', device.name + ' is offline.', 'Turn it on in the Tuya app, or check its power and network.');
  }
  const code = pickSwitchCode(device.state);
  if (!code) {
    throw new TuyaError('NO_SWITCH', device.name + ' has no on/off property this plugin can toggle.', 'Open the device in the Tuya app.');
  }
  const next = !device.state[code];
  const requested = {};
  requested[code] = next;
  const validated = validateProperties(await loadModel(deviceId, callId), requested);
  await postProperties(deviceId, validated.raw, callId);
  invalidateCache();
  return { ok: true, device_id: deviceId, name: device.name, changed: validated.applied };
}

/* ------------------------------------------------------------- tools --- */

/** @param {Record<string, *>} args @param {string} [callId] @returns {Promise<ToolResult>} */
async function toolListDevices(args, callId) {
  const snapshot = await buildSnapshot({ callId: callId, force: args.refresh === true });
  let devices = snapshot.devices;
  if (args.home_id) devices = devices.filter(function (d) { return String(d.home_id) === String(args.home_id); });
  if (args.room_id) devices = devices.filter(function (d) { return String(d.room_id) === String(args.room_id); });

  const matched = devices.length;
  const capped = devices.slice(0, MAX_DEVICES_IN_SNAPSHOT);
  return {
    ok: true,
    summary: formatSnapshot(Object.assign({}, snapshot, { devices: capped, device_total: matched }), {
      filtered: Boolean(args.home_id || args.room_id)
    }),
    count: capped.length,
    matched: matched,
    homes: snapshot.homes,
    devices: capped
  };
}

/** @param {Record<string, *>} args @param {string} [callId] @returns {Promise<ToolResult>} */
async function toolListHomes(args, callId) {
  const snapshot = await buildSnapshot({ callId: callId });
  const lines = snapshot.homes.map(function (home) {
    return home.name + ' (' + home.home_id + '): ' +
      (home.rooms.length ? home.rooms.map(function (r) { return r.name; }).join(', ') : 'no rooms');
  });
  return {
    ok: true,
    summary: lines.length ? lines.join('\n') : 'This Tuya account has no homes.',
    homes: snapshot.homes
  };
}

/** @param {Record<string, *>} args @param {string} [callId] @returns {Promise<ToolResult>} */
async function toolGetDevice(args, callId) {
  const deviceId = assertDeviceId(args.device_id);
  const device = await readDevice(deviceId, callId);
  const lines = [
    device.name + ' — ' + (device.online ? 'online' : 'offline'),
    'Current state:',
    ...Object.entries(device.state).slice(0, SUMMARY_ITEMS).map(function ([code, value]) {
      return '  ' + code + ' = ' + JSON.stringify(value);
    }),
    'Writable:',
    ...device.writable.slice(0, SUMMARY_ITEMS).map(function (property) {
      return '  ' + property.code + ' (' + property.type + ') ' + property.accepts + ' — ' + property.name;
    })
  ];
  return Object.assign({ ok: true, summary: lines.join('\n') }, device);
}

/** @param {Record<string, *>} args @param {string} [callId] @returns {Promise<ToolResult>} */
async function toolSetDevice(args, callId) {
  const deviceId = assertDeviceId(args.device_id);
  const requested = args.properties;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new TuyaError('INVALID_VALUE', 'properties must be an object of code to value.', 'Example: {"switch_led": true}.');
  }

  const model = await loadModel(deviceId, callId);
  const validated = validateProperties(model, requested);

  await postProperties(deviceId, validated.raw, callId);

  invalidateCache();

  return {
    ok: true,
    summary: 'Sent to ' + deviceId + ': ' + Object.entries(validated.applied)
      .map(function ([code, value]) { return code + ' = ' + JSON.stringify(value); }).join(', ') +
      '. Tuya applies the command on the device; it is not an instant acknowledgement.',
    device_id: deviceId,
    applied: validated.applied
  };
}

/** @param {Record<string, *>} args @param {string} [callId] @returns {Promise<ToolResult>} */
async function toolRenameDevice(args, callId) {
  const deviceId = assertDeviceId(args.device_id);
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (name.length < 1 || name.length > 40) {
    throw new TuyaError('INVALID_VALUE', 'name must be 1 to 40 characters.', 'Pass the name the user said.');
  }
  await tuya('/v1.0/end-user/devices/' + encodeURIComponent(deviceId) + '/attribute', {
    method: 'POST',
    body: { name: name },
    callId: callId
  });
  invalidateCache();
  return { ok: true, summary: 'Renamed ' + deviceId + ' to "' + name + '".', device_id: deviceId, name: name };
}

/* --------------------------------------------------- home management --- */

/* Room creation, room assignment and device removal are Smart Home calls
 * (/v1.0/homes/..., /v1.0/devices/...), not /v1.0/end-user/ reads. Same host
 * and same Bearer key, but the key must be allowed to manage the home itself.
 * If it is a pure end-user key, Tuya answers with an auth/permission code and
 * the honest advice is the Tuya app, so keep that difference visible. */
async function structureApi(path, opts) {
  try {
    return await tuya(path, opts);
  } catch (err) {
    if (err && (err.code === 'AUTH' || err.code === 'API_ERROR')) {
      /* Tuya answers 1010 here even when the key is healthy, because this path
       * is not served by the end-user family. Do not pass on the generic
       * "the key expired" advice: it sends the user to replace a good key. */
      throw new TuyaError(
        err.code,
        err.message,
        'This is a home-structure call (' + path + ') and the saved key may not cover it. ' +
        'Reads and control still work with the same key, so a 1010 here means the family is wrong, not that the key expired. ' +
        'Doing it in the Tuya app is the reliable route.'
      );
    }
    throw err;
  }
}

async function resolveHome(homeId, callId) {
  const snapshot = await buildSnapshot({ callId: callId });
  const homes = snapshot.homes || [];
  if (!homes.length) {
    throw new TuyaError('NO_HOME', 'This Tuya account has no home.', 'Create a home in the Tuya app first.');
  }
  const available = 'Homes: ' + homes.map(function (h) { return h.home_id + ' (' + h.name + ')'; }).join(', ');
  if (!homeId) {
    if (homes.length === 1) return homes[0];
    throw new TuyaError('HOME_REQUIRED', 'This account has ' + homes.length + ' homes.', 'Pass home_id. ' + available);
  }
  const wanted = String(homeId);
  const found = homes.find(function (h) { return String(h.home_id) === wanted; });
  if (!found) throw new TuyaError('HOME_NOT_FOUND', 'No home with id ' + wanted + '.', available);
  return found;
}

function assertRoomName(name) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (clean.length < 1 || clean.length > 40) {
    throw new TuyaError('INVALID_VALUE', 'Room name must be 1 to 40 characters.', 'Pass the name the user said.');
  }
  return clean;
}

/* Home-structure calls are off unless the user turned them on. A Tuya
 * end-user key cannot change a home's structure, so these three tools used to
 * exist only to fail; now they refuse locally and tell the model to stop, which
 * keeps the marketplace surface honest. */
async function isAdvancedEnabled() {
  const kv = await kvGet();
  return kv.advancedStructure === true;
}

async function requireAdvanced(tool) {
  if (await isAdvancedEnabled()) return;
  throw new TuyaError(
    'ADVANCED_REQUIRED',
    tool + ' is an advanced tool and home-structure changes are disabled in the plugin settings.',
    'Do not retry. Tell the user that changing rooms or unbinding devices is off by default ' +
    'and is not something a Tuya end-user key can do reliably; the Tuya app is the right place. ' +
    'Only if they explicitly ask for the advanced tools should they switch them on in the plugin settings.'
  );
}

/** @param {Record<string, *>} args @param {string} [callId] @returns {Promise<ToolResult>} */
async function toolCreateRoom(args, callId) {
  const name = assertRoomName(args.name);
  const home = await resolveHome(args.home_id, callId);

  const existing = (home.rooms || []).find(function (room) {
    return String(room.name).trim().toLowerCase() === name.toLowerCase();
  });
  if (existing) {
    return {
      summary: 'Room "' + existing.name + '" already exists in ' + home.name + ' (id ' + existing.room_id + ').',
      ok: true,
      created: false,
      room_id: existing.room_id,
      home_id: home.home_id
    };
  }

  /* Two families spell this differently. Auditable either way: the reply names
   * the family that answered. */
  const encodedHome = encodeURIComponent(home.home_id);
  // The documented Smart Home path answers; the end-user sibling is kept as a
  // fallback because older keys only knew that family (see docs/VERIFIED.md).
  const candidates = [
    { family: 'smart-home', path: '/v1.0/homes/' + encodedHome + '/room' },
    { family: 'end-user', path: '/v1.0/end-user/homes/' + encodedHome + '/rooms' }
  ];
  const attempts = [];

  for (const candidate of candidates) {
    try {
      const result = await structureApi(candidate.path, {
        method: 'POST',
        body: { name: name },
        callId: callId
      });
      invalidateCache();

      const roomId = result && (result.room_id || result.roomId || result.id);
      return {
        summary: 'Created room "' + name + '" in ' + home.name + ' via the ' + candidate.family + ' API' +
          (roomId ? ' (id ' + roomId + ')' : '') + '.',
        ok: true,
        created: true,
        room_id: roomId === undefined ? null : roomId,
        home_id: home.home_id,
        api: candidate.family
      };
    } catch (err) {
      attempts.push(candidate.family + ' -> ' + err.message);
      /* A timeout or a server error may already have created the room: posting
       * the same request to the other family would leave a duplicate. */
      const mayHaveLanded =
        (err && err.code === 'NETWORK' && err.ambiguous) ||
        (err && (err.code === 'SERVER' || err.code === 'BAD_RESPONSE'));
      if (mayHaveLanded) throw err;
    }
  }

  throw new TuyaError(
    'CREATE_ROOM_FAILED',
    'Tuya refused to create the room. ' + attempts.join(' | '),
    'Neither room endpoint accepted the key, so this key cannot change the home structure. ' +
    'Create rooms in the Tuya app; reading devices and switching them keeps working here.'
  );
}

/** @param {Record<string, *>} args @param {string} [callId] @returns {Promise<ToolResult>} */
async function toolAssignDeviceRoom(args, callId) {
  const deviceId = assertDeviceId(args.device_id);
  if (args.room_id === undefined || args.room_id === null || String(args.room_id).trim() === '') {
    throw new TuyaError('INVALID_VALUE', 'room_id is required.', 'Call list_homes and pass one of the returned room ids.');
  }
  const roomId = String(args.room_id).trim();

  const snapshot = await buildSnapshot({ callId: callId, force: args.refresh === true });
  const device = findDevice(snapshot, deviceId);
  const home = await resolveHome(args.home_id || device.home_id, callId);
  const room = (home.rooms || []).find(function (r) { return String(r.room_id) === roomId; });
  if (!room) {
    throw new TuyaError(
      'ROOM_NOT_FOUND',
      'No room ' + roomId + ' in ' + home.name + '.',
      'Rooms here: ' + ((home.rooms || []).map(function (r) { return r.room_id + ' (' + r.name + ')'; }).join(', ') || 'none yet')
    );
  }

  await structureApi('/v1.0/homes/' + encodeURIComponent(home.home_id) + '/rooms/' + encodeURIComponent(roomId) + '/devices', {
    method: 'POST',
    body: { device_ids: [deviceId] },
    callId: callId
  });
  invalidateCache();

  return {
    ok: true,
    summary: 'Put ' + device.name + ' in ' + room.name + ' (' + home.name + ').',
    device_id: deviceId,
    device_name: device.name,
    room_id: roomId,
    room_name: room.name,
    home_id: home.home_id
  };
}

/** @param {Record<string, *>} args @param {string} [callId] @returns {Promise<ToolResult>} */
async function toolRemoveDevice(args, callId) {
  const deviceId = assertDeviceId(args.device_id);
  /* Both cameras in this home are called "Dvor", so a name is not proof of
   * identity. Demand the id itself, repeated, so a look-alike is never the one
   * that gets unbound. */
  if (String(args.confirm_device_id || '') !== deviceId) {
    throw new TuyaError(
      'CONFIRMATION_REQUIRED',
      'Refusing to remove a device without confirm_device_id matching device_id exactly.',
      'Removing a device unbinds it from the Tuya cloud and the app. Repeat the exact device_id in confirm_device_id.'
    );
  }

  const snapshot = await buildSnapshot({ callId: callId, force: true });
  const device = findDevice(snapshot, deviceId);

  await structureApi('/v1.0/devices/' + encodeURIComponent(deviceId), { method: 'DELETE', callId: callId });
  invalidateCache();

  return {
    ok: true,
    summary: 'Removed ' + device.name + ' (' + device.category_name + ', ' + deviceId + ') from the Tuya cloud.',
    device_id: deviceId,
    device_name: device.name,
    category_name: device.category_name,
    was_online: device.online === true
  };
}

/* ------------------------------------------------------------- status --- */

function regionForBase(base) {
  for (let i = 0; i < DATA_CENTRES.length; i++) {
    if (DATA_CENTRES[i].base === base) return DATA_CENTRES[i].region;
  }
  return null;
}

/** @param {Record<string, *>} args @param {string} [callId] @returns {Promise<ToolResult>} */
async function toolStatus(args, callId) {
  const opts = args || {};
  if (opts.refresh === true) {
    verifiedBase = null;
    invalidateCache({ models: true });
    await kvPatch({ baseHost: null, baseRegion: null, probedAt: null });
  }

  const base = await resolveBase(callId);
  const reuseProbe = probeHomes.base === base && Date.now() - probeHomes.at < 5000;
  const result = reuseProbe
    ? probeHomes.value
    : await tuya('/v1.0/end-user/homes/all', { callId: callId, timeoutMs: PROBE_TIMEOUT_MS });
  const homes = asArray(result, 'homes');
  const region = regionForBase(base);

  const kvAfter = await kvGet();

  return {
    ok: true,
    summary: 'Connected to Tuya ' + (region || 'unknown') + ' (' + base + '): ' +
      homes.length + ' home(s) visible to this key.',
    region: region,
    base: base,
    advanced_structure: await isAdvancedEnabled(),
    homes_visible: homes.length,
    cache: {
      base_override: kvAfter.baseOverride || null,
      base_host: kvAfter.baseHost || null,
      base_region: kvAfter.baseRegion || null,
      probed_at: kvAfter.probedAt || null,
      verified_base: verifiedBase
    }
  };
}

/* One table: the handler and whether the tool needs the advanced setting. The
 * dispatcher reads the flag, so the surface and the gate cannot drift apart. */
const TOOLS = {
  list_devices: { handler: toolListDevices },
  list_homes: { handler: toolListHomes },
  get_device: { handler: toolGetDevice },
  set_device: { handler: toolSetDevice },
  rename_device: { handler: toolRenameDevice },
  create_room: { handler: toolCreateRoom, advanced: true },
  assign_device_room: { handler: toolAssignDeviceRoom, advanced: true },
  remove_device: { handler: toolRemoveDevice, advanced: true },
  tuya_status: { handler: toolStatus }
};

/* ------------------------------------------------------------- panel --- */

const channel = new BroadcastChannel(CHANNEL);

const seenPanelRequests = new Set();

async function handlePanelMessage(msg) {
  if (!msg || typeof msg.reqId !== 'string') return;
  const reply = function (payload) {
    channel.postMessage(Object.assign({ type: 'panel-response', reqId: msg.reqId }, payload));
  };

  /* The page re-sends the same reqId until it hears back. Handling it twice
   * would duplicate a whole snapshot read, and a toggle would flip the device
   * twice, so a reqId is answered exactly once. */
  if (seenPanelRequests.has(msg.reqId)) return;
  seenPanelRequests.add(msg.reqId);
  if (seenPanelRequests.size > 200) seenPanelRequests.clear();

  /* settings.js invalidates caches after a /kv write; it does not want a snapshot. */
  if (msg.action === 'invalidate') {
    invalidateCache({ models: true });
    reply({ ok: true });
    return;
  }

  try {
    if (msg.action === 'refresh') {
      const snapshot = await buildSnapshot({ force: true });
      reply({ ok: true, snapshot: snapshot });
      return;
    }
    if (msg.action === 'status') {
      const result = await toolStatus(msg.args || {}, undefined);
      reply({ ok: true, status: result });
      return;
    }
    if (msg.action === 'toggle') {
      const result = await toggleDevice(assertDeviceId(msg.device_id), undefined);
      const snapshot = await buildSnapshot({ force: true });
      reply({ ok: true, snapshot: snapshot, message: 'Switched ' + result.name });
      return;
    }
    reply({ ok: false, errorCode: 'UNKNOWN_ACTION', message: 'Unknown panel action: ' + msg.action });
  } catch (err) {
    reply({
      ok: false,
      errorCode: err && err.code ? err.code : 'INTERNAL',
      message: err && err.message ? err.message : 'Unexpected failure.',
      hint: (err && err.hint) || ''
    });
  }
}

channel.onmessage = function (event) {
  handlePanelMessage(event.data).catch(function () { /* reply already attempted */ });
};

/* -------------------------------------------------------- host wiring --- */

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;

  const callId = msg.callId;
  const entry = TOOLS[msg.tool];

  if (!entry) {
    cindy.send({
      type: 'tool-result',
      callId: callId,
      ok: false,
      errorCode: 'UNKNOWN_TOOL',
      message: 'This plugin has no tool named "' + msg.tool + '".',
      hint: 'Call list_devices, list_homes, get_device, set_device, rename_device, create_room, assign_device_room, remove_device or tuya_status.',
    });
    return;
  }

  try {
    if (entry.advanced) await requireAdvanced(msg.tool);
    const result = await entry.handler(msg.args || {}, callId);
    cindy.send({ type: 'tool-result', callId: callId, ok: true, result: result });
  } catch (err) {
    const isTuya = err instanceof TuyaError;
    cindy.send({
      type: 'tool-result',
      callId: callId,
      ok: false,
      errorCode: isTuya ? err.code : 'INTERNAL',
      message: (err && err.message) || 'Unexpected failure.',
      hint: isTuya ? err.hint : ''
    });
  }
});
