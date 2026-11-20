/* Tuya Home — settings page.
 * The API key is handed to the host vault and never read back; GET /secrets only
 * reports whether a key is saved plus a 4-character tail fingerprint.
 */

const $ = function (id) { return document.getElementById(id); };

const CHANNEL = 'tuya-home';
const SECRET_KEY = 'tuya_api_key';
const channel = new BroadcastChannel(CHANNEL);

/* Ask the brain for a fresh read. Same protocol as panel.js: one reqId, one
 * answer, retries only for reads. The brain is started on demand, so wake it
 * first and re-send until it answers or we give up. */
/**
 * Ask the brain over BroadcastChannel and wait for the matching reply.
 * @param {string} action one of refresh, status, toggle, invalidate
 * @param {Record<string, *>} [payload] extra fields sent with the request
 * @param {{timeoutMs?: number, retry?: boolean}} [options] writes set retry:false
 * @returns {Promise<{ok: boolean, errorCode?: string, message?: string,
 *   hint?: string, snapshot?: object, status?: object}|null>} null on timeout
 */
function ask(action, payload, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 15000;
  const retry = opts.retry !== false;
  return new Promise(function (resolve) {
    const reqId = 'panel-' + Math.random().toString(36).slice(2);
    let done = false;
    let timer = null;
    let deadline = null;

    const finish = function (value) {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(deadline);
      channel.removeEventListener('message', onMessage);
      resolve(value);
    };

    const onMessage = function (event) {
      const msg = event.data;
      if (msg && msg.type === 'panel-response' && msg.reqId === reqId) finish(msg);
    };
    channel.addEventListener('message', onMessage);

    const send = function () {
      channel.postMessage(Object.assign({ type: 'panel-request', reqId: reqId, action: action }, payload || {}));
    };

    if (retry) timer = setInterval(send, 400);
    deadline = setTimeout(function () { finish(null); }, timeoutMs);

    try {
      fetch('cindy-ghost://tuya-home/wake').catch(function () { /* retries cover a cold start */ });
    } catch (_) { /* ignore */ }
    send();
  });
}

async function readKv() {
  const response = await fetch('/kv');
  if (!response.ok) throw new Error('Could not read the plugin settings (HTTP ' + response.status + ').');
  const value = await response.json();
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/* /kv is a whole-document PUT, so two overlapping read-modify-write cycles would
 * drop each other's key. Every write waits for the previous one. */
let kvQueue = Promise.resolve();

function writeKv(patch) {
  const run = async function () {
    const current = await readKv();
    const next = Object.assign({ schema: 1 }, current, patch);
    const response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(next) });
    if (response.status < 200 || response.status >= 300) {
      throw new Error('Could not save the plugin settings (HTTP ' + response.status + ').');
    }
    /* The brain caches the snapshot and the verified data centre, so tell it to
     * re-read after a settings change. Best effort: the write already succeeded. */
    try {
      channel.postMessage({ type: 'panel-request', reqId: 'invalidate-' + Date.now(), action: 'invalidate' });
    } catch (_) {
      /* the brain is woken on the next tool call anyway */
    }
    return next;
  };
  const queued = kvQueue.then(run, run);
  kvQueue = queued.catch(function () { /* keep the queue alive */ });
  return queued;
}

async function refreshKeyState() {
  const label = $('keystate');
  try {
    const response = await fetch('/secrets');
    if (!response.ok) throw new Error('Could not read the saved key (HTTP ' + response.status + ').');
    const items = await response.json();
    const entry = Array.isArray(items) ? items.find(function (item) { return item.key === SECRET_KEY; }) : null;
    if (entry && entry.saved) {
      label.textContent = 'Key saved' + (entry.tail ? ' (ends in ' + entry.tail + ')' : '') + '.';
    } else {
      label.textContent = 'No key saved yet — this plugin cannot reach Tuya until you add one.';
    }
  } catch (err) {
    label.textContent = 'Could not read the key status: ' + err.message;
  }
}

async function refreshRegionState() {
  const detected = $('detected');
  let kv;
  try {
    kv = await readKv();
  } catch (err) {
    detected.textContent = 'Could not read the saved data centre: ' + err.message;
    return;
  }
  $('region').value = kv.baseOverride || '';
  $('advanced').checked = kv.advancedStructure === true;
  if (kv.baseRegion) {
    detected.textContent = 'Last key worked in: ' + kv.baseRegion + ' (' + (kv.baseHost || '') + ').';
  } else {
    detected.textContent = 'No data centre detected yet — run a connection test.';
  }
}

$('save').addEventListener('click', async function () {
  const input = $('key');
  const value = input.value.trim();
  const state = $('keystate');

  if (!value) {
    state.textContent = 'Paste a key first.';
    return;
  }
  if (!/^sk-/.test(value)) {
    state.textContent = 'That does not look like a Tuya key: it should start with "sk-".';
    return;
  }

  $('save').disabled = true;
  try {
    const response = await fetch('/secrets/' + SECRET_KEY, {
      method: 'PUT',
      body: JSON.stringify({ value: value })
    });
    if (response.status !== 204) {
      state.textContent = 'Saving failed (HTTP ' + response.status + '). Try again.';
      return;
    }
    input.value = '';
    /* A new key can belong to a different region: forget the old discovery. */
    await writeKv({ baseHost: null, baseRegion: null });
    await refreshKeyState();
    await refreshRegionState();
  } catch (err) {
    state.textContent = 'Saving the key failed: ' + err.message;
  } finally {
    $('save').disabled = false;
  }
});

$('clear').addEventListener('click', async function () {
  const state = $('keystate');
  try {
    const response = await fetch('/secrets/' + SECRET_KEY, { method: 'DELETE' });
    if (response.status !== 204) {
      state.textContent = 'Removing the key failed (HTTP ' + response.status + ').';
      return;
    }
    await writeKv({ baseHost: null, baseRegion: null });
    await refreshKeyState();
    await refreshRegionState();
  } catch (err) {
    state.textContent = 'Removing the key failed: ' + err.message;
  }
});

$('region').addEventListener('change', async function () {
  try {
    await writeKv({ baseOverride: $('region').value || null, baseHost: null });
    await refreshRegionState();
  } catch (err) {
    $('detected').textContent = 'Could not save the data centre: ' + err.message;
  }
});

$('test').addEventListener('click', async function () {
  const box = $('test-result');
  const button = $('test');
  box.style.display = 'block';
  box.className = 'status';
  box.textContent = 'Asking Tuya…';
  button.disabled = true;

  try {
    const reply = await ask('status', {}, { timeoutMs: 15000 });
    if (!reply) {
      box.className = 'status bad';
      box.textContent = 'The plugin did not answer. It may be disabled, or the app is busy — try again.';
      return;
    }
    if (!reply.ok) {
      box.className = 'status bad';
      box.textContent = reply.message + (reply.hint ? ' ' + reply.hint : '');
      return;
    }
    const status = reply.status || {};
    box.className = 'status ok';
    /* The brain's summary already ends with the home count: never append it twice. */
    if (status.summary) {
      box.textContent = status.summary;
    } else if (status.homes_visible !== undefined) {
      box.textContent = status.homes_visible + ' home(s) visible to this key.';
    } else {
      box.textContent = 'Connected to ' + (status.region || 'Tuya') + '.';
    }
    await refreshRegionState();
  } finally {
    button.disabled = false;
  }
});

$('advanced').addEventListener('change', async function () {
  const wanted = this.checked === true;
  try {
    await writeKv({ advancedStructure: wanted });
  } catch (err) {
    this.checked = !wanted;
    const box = $('test-result');
    box.style.display = 'block';
    box.className = 'status bad';
    box.textContent = 'Could not save the advanced setting: ' + err.message;
  }
});

refreshKeyState();
refreshRegionState();
