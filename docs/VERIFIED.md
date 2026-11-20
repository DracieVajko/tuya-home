# Verified behaviour

What was actually exercised against a live Tuya home on `eu-c` (November 2026),
not copied from documentation. Anything here marked *observed* came back from
the API; anything else is an inference and is labelled as such.

## Key families

| Capability | `sk-` end-user key | Project credentials + linked app account |
|---|---|---|
| Read homes, rooms, devices | yes | yes |
| Read/set device properties | yes | yes |
| Rename a device | yes | yes |
| Create a room | **no** — `1108 uri path invalid` on the end-user family, `1010 token invalid` on the Smart Home family | yes |
| Put a device in a room | **no** — same wall | yes |
| Unbind a device | **no** — `1010` on `DELETE /v1.0/devices/{id}` | yes, until the quota stops it |

The Cindy plugin does ship an unbind tool (`remove_device`), behind the
off-by-default *Advanced — home structure* setting, and it demands the device id
twice. It is documented as permanent: the device leaves the Tuya app and must be
paired again. It does not work with an end-user key; that is the row above.

Reads keep working on the very same key while those calls fail, so a `1010` on
a home-structure call means the token family is wrong. It does **not** mean the
key expired, and telling the user to replace a healthy key is a bug. The plugin
says this explicitly instead.

## Control surface by device class (observed)

- **Smart breaker / plug** (`tdq`, `dlq`): `switch_1` (bool), `countdown_1` (s),
  `relay_status` (`off|on|memory`), inching/cycle/random timers, and on some
  models live `cur_power` / `cur_current` / `cur_voltage` metering.
  Round trip verified: `false → true → false` with a read-back after each step.
- **Smart electricity meter** (`zndb`): per-phase voltage/current/power, energy
  counters, threshold settings (`over_voltage` 130–290 V, `over_current`,
  `over_power`, `over_temp`), `energy_clear` / `runtime_clear`, `switch`.
- **EV charger** (`qccdz`): `work_mode`
  (`charge_now|charge_pct|charge_energy|charge_schedule`), `switch`, current
  caps `Set16A` / `Set32A` / `Set40A` / `Set50A` / `set80a` with **per-model**
  ranges, `SetDelayTime` / `SetDefineTime`, `RFID`, `ChargingOperation`.
- **Robot vacuum** (`sd`): `switch_go`, `pause`, `switch_charge`, `mode`
  (`smart|chargego|zone|pose|part|edge|explore|exploreclean`), `suction`,
  `cistern`, `seek`, `direction_control`, per-part life counters, and map /
  schedule payloads as base64 blobs.
- **Camera** (`dmsxj`, `sxj4g`): motion switch + sensitivity + interval,
  humanoid filter, night vision mode, PTZ, siren, floodlight, privacy mode,
  ONVIF, SD record/format, volume.
- **Light / switch** (`dj`, `kg`): `switch_1`, `countdown_1`, `relay_status`,
  plus a backlight flag on wall switches.

## Local validation happens before any request

Verified to be refused **locally**, with no network write:

| Input | Result |
|---|---|
| unknown property code | `INVALID_PROPERTY` + the list of writable codes |
| wrong type (`"yes"` for a bool) | `INVALID_VALUE` |
| out of range (`over_voltage = 999`) | `OUT_OF_RANGE` with the real limits |
| enum outside its range | `INVALID_VALUE` + the allowed values |

## Limits found the hard way

- **Free/trial project edition caps the controllable device pool at 10**
  (`60001001`). It fails the eleventh assignment and — surprisingly — also
  refuses `DELETE` of a device once at the cap. Beyond ten devices needs a paid
  IoT Core plan. Observed on a 16-device home: exactly ten succeeded.
- **Offline devices still report state** and their writable list, because that
  comes from the cloud shadow (observed). Whether a write to an offline device
  is queued or dropped was *not* tested here — Tuya's command model is
  asynchronous, so treat it as unknown rather than as success.
- **Opaque base64 fields** (`_map_room_info1`, `Schedule1..7`, `alarm_set_1`,
  `maintenance`, …) carry device-internal structures. Never write them blindly.

## Room names and device names are two separate truths

A robot vacuum keeps its own room names inside its map payload; the home's
rooms are a different namespace. Renaming a room does not rename the map, and
the vacuum can use English map names while the home uses another language.
Align them in the Tuya app if voice assistants should not hear two vocabularies.

## The MCP variant exposes six tools on purpose

`variants/mcp/tuya_mcp.py` has no room/assign/remove tools. That is not drift:
those need project credentials, so a portable server built around an end-user
key should not advertise them. The Cindy plugin keeps them behind an advanced
setting; the portable server simply omits them.

It is covered by `variants/mcp/tests/test_mcp.py`, which runs the server over
stdio against a local fake Tuya API (`tests/fake_tuya.py`) and asserts: the tool
surface, room grouping and filtering, that read-only properties are not
advertised, that bad codes/enums/ranges are refused **before** any request is
sent, that a write survives Tuya's burst-cap rejection and reaches the API
exactly once, that `22.5` with scale 1 is sent as the raw `225`, that a dead
endpoint is reported as `NETWORK` rather than a rejected key, and that a missing
key stops the process with a clear message.

## Reproducing any of this

```bash
node tools/project-probe.mjs              # read-only: token + rooms
node tools/project-probe.mjs --rooms      # room ids
node tools/project-probe.mjs --create-room="Name"
node tools/project-probe.mjs --assign=ROOM_ID:device_id,device_id
node tools/project-probe.mjs --remove-device=device_id
```

Credentials live in `tools/.env` (gitignored). The script never prints them,
nor the access token.

A pattern that works well: mutate through the project token, then confirm with
the plugin's `sk-` key (`list_devices` with `refresh: true`). Two independent
paths agreeing is stronger evidence than either alone.
