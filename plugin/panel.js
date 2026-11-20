/* Tuya Home — panel.
 * Runs in the same sandbox as the brain: no direct network, so every read goes
 * through BroadcastChannel to main.js, which owns the Tuya calls.
 */

const CHANNEL = 'tuya-home';
const channel = new BroadcastChannel(CHANNEL);
const list = document.getElementById('list');
const headline = document.getElementById('headline');
const refreshButton = document.getElementById('refresh');

let busy = false;

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
  /* Reads can be re-sent while the brain wakes up; a write must be sent once. */
  const retry = opts.retry !== false;
  return new Promise(function (resolve) {
    const reqId = 'panel-' + Math.random().toString(36).slice(2);
    let done = false;

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

    const timer = retry ? setInterval(send, 400) : null;
    const deadline = setTimeout(function () { finish(null); }, timeoutMs);

    /* The brain is started on demand: wake it, then keep re-sending until it answers. */
    try {
      fetch('cindy-ghost://tuya-home/wake').catch(function () { /* retries cover it */ });
    } catch (_) { /* ignore */ }
    send();
  });
}

function showError(message) {
  list.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'error';
  box.textContent = message;
  list.appendChild(box);
}

function render(snapshot) {
  list.innerHTML = '';

  const devices = snapshot.devices || [];
  headline.textContent = devices.length
    ? devices.length + ' device' + (devices.length === 1 ? '' : 's')
    : 'Devices';

  if (devices.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No devices visible to this key.';
    list.appendChild(empty);
    return;
  }

  const homeNames = new Map();
  for (const home of snapshot.homes || []) homeNames.set(home.home_id, home.name);

  const order = [];
  const grouped = new Map();
  for (const device of devices) {
    const homeKey = device.home_id || '';
    const roomKey = device.room_name || 'No room';
    const key = homeKey + '\u0000' + roomKey;
    if (!grouped.has(key)) {
      grouped.set(key, { home: homeNames.get(homeKey) || null, room: roomKey, devices: [] });
      order.push(key);
    }
    grouped.get(key).devices.push(device);
  }

  let lastHome = null;
  for (const key of order) {
    const bucket = grouped.get(key);
    if (bucket.home && bucket.home !== lastHome) {
      const heading = document.createElement('div');
      heading.className = 'group-title';
      heading.textContent = bucket.home;
      list.appendChild(heading);
      lastHome = bucket.home;
    }
    if (bucket.room !== 'No room') {
      const room = document.createElement('div');
      room.className = 'room-title';
      room.textContent = bucket.room;
      list.appendChild(room);
    }

    for (const device of bucket.devices) {
      const row = document.createElement('div');
      row.className = 'device' + (device.online ? '' : ' offline');

      const dot = document.createElement('span');
      dot.className = 'dot' + (device.online ? ' online' : '');
      dot.title = device.online ? 'Online' : 'Offline';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = device.name;
      name.title = device.device_id;

      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = device.category_name || '';

      const toggle = document.createElement('button');
      toggle.textContent = '\u23FB';
      toggle.title = 'Toggle power';
      toggle.disabled = !device.online;
      toggle.addEventListener('click', function () {
        toggle.disabled = true;
        togglePower(device);
      });

      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(kind);
      row.appendChild(toggle);
      list.appendChild(row);
    }
  }
}

async function togglePower(device) {
  if (busy) return;
  busy = true;
  refreshButton.disabled = true;
  try {
    const reply = await ask('toggle', { device_id: device.device_id }, { retry: false, timeoutMs: 25000 });
    if (!reply) {
      showError('The plugin did not answer in time. Try again.');
      return;
    }
    if (!reply.ok) {
      showError((reply.message || 'Could not switch the device.') + (reply.hint ? ' ' + reply.hint : ''));
      return;
    }
    if (reply.snapshot) render(reply.snapshot);
  } finally {
    busy = false;
    refreshButton.disabled = false;
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  refreshButton.disabled = true;
  headline.textContent = 'Reading…';
  try {
    const reply = await ask('refresh', {}, { timeoutMs: 20000 });
    if (!reply) {
      showError('The plugin did not answer in time. Open the plugin settings and run a connection test.');
      return;
    }
    if (!reply.ok) {
      showError((reply.message || 'Tuya read failed.') + (reply.hint ? ' ' + reply.hint : ''));
      return;
    }
    render(reply.snapshot || { homes: [], devices: [] });
  } finally {
    busy = false;
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', refresh);

list.addEventListener('scroll', function () {
  list.classList.add('is-scrolling');
  clearTimeout(list._scrollTimer);
  list._scrollTimer = setTimeout(function () { list.classList.remove('is-scrolling'); }, 2000);
});

refresh();
