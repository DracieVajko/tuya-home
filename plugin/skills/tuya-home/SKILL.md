---
name: tuya-home
description: "Read and control the user's Tuya / Smart Life smart home devices. Use for lights, plugs, air conditioners, sensors and curtains: what is on, current state, switch, brightness, temperature, mode, rooms and homes."
---

# Tuya Home

Cloud-bridged control of the user's Tuya account. The API key lives in Cindy's
vault; you never see it, and you never need to.

## Order of operations

1. `list_devices` — homes, rooms, devices, online flags. This is almost always
   the first call: it tells you the real names and the `device_id` values.
   Narrow with `home_id` for a big account. Pass `refresh: true` only when the
   user says something changed in the last moment.
2. `get_device` — current property values plus what the device actually accepts,
   with ranges and units. Do this before any change you are not certain about.
   The printed summary stops at 24 state entries and 24 writable properties; the
   `state` and `writable` arrays in the same result are complete, so read them
   when a device has more.
3. `set_device` — validated write. Unknown codes, read-only codes and
   out-of-range values are rejected locally with the list of what is allowed, so
   a bad guess costs nothing on the device.
4. `rename_device` — only when the user asks to rename. It changes the name in
   their Tuya app too.
5. `list_homes` — only needed for the home/room hierarchy itself.
6. `create_room` — only when the user asks for rooms. Repeating a name that
   already exists returns the existing room with `created: false`, so it is
   safe to run twice; it never makes a duplicate.
7. `assign_device_room` — moves one device into a room of its home. Room ids
   come from `list_homes`.
8. `remove_device` — unbinds (removes) a device from the Tuya cloud and the
   account. It is destructive and not undoable from here, so it demands
   `confirm_device_id` repeating `device_id` exactly: two cameras in one home can
   both be called "Dvor", and a display name is not proof of identity. Read
   [Removal is destructive](#removal-is-destructive--say-so-before-you-call-it)
   before you call it.

## The three structural tools are off by default

`create_room`, `assign_device_room` and `remove_device` return
`ADVANCED_REQUIRED` unless the user switched on *Advanced — home structure* in
the plugin settings. Do not retry and do not look for another way: tell the
user plainly that changing rooms or unbinding devices is off by default, that a
Tuya end-user key cannot do it reliably, and that the Tuya app is the right
place. Only point them at the setting if they explicitly want the advanced
tools for their own reasons.

## Home-management calls are a different permission family

`create_room`, `assign_device_room` and `remove_device` are Smart Home calls
(`/v1.0/homes/...`, `/v1.0/devices/...`), not end-user reads. An end-user key
may be refused (usually Tuya code 1106, or 1010 on `remove_device`). Say exactly
that when it happens and point the user at the Tuya app. Never report a refusal
as a completed change.

## Removal is destructive — say so before you call it

`remove_device` is the one action here that changes the user's account for good.
It is available; it is just narrow. All of these must hold, or nothing reaches
Tuya:

1. *Advanced — home structure* is ticked in the plugin settings (off on install);
2. the user named the device they want removed — never infer it from "the camera";
3. `device_id` and `confirm_device_id` are the same exact value;
4. the saved key is allowed to manage this home. A plain end-user `sk-` key is
   refused (1010 on this family, 1108 on the end-user one), and reads, switches,
   values and renames keep working on that same key.

What the user loses when it succeeds: the device leaves their Tuya account, the
Tuya / Smart Life app, and any scene or automation that used it. Nothing restores
it from the plugin. Coming back means pairing the device again in the Tuya app
and rebuilding its scenes, rooms and automations. Say that out loud, in one
sentence, before you send the call — not after it fails.

Never describe the plugin as unable to remove a device: it can, under the four
conditions above. Never describe it as harmless either. If the user did not ask
for a removal, do not mention the tool as an option.

## Take every range from `get_device`, then work in that range

Tuya devices do not share a scale. An air conditioner commonly declares 16 to 30
with a decimal place, so `22` and `22.5` are valid and the plugin turns them into
the device's raw integer. A light commonly declares 10 to 1000 with no decimal
place, so half brightness is `500`, not `50`.

So: read the property's range from `get_device`, keep the user's intent inside
it, and convert percentages yourself (50% of 10–1000 is 500). Never invent a
range, never send a raw Tuya integer that you scaled by hand, and never send a
percentage where the device expects kelvin, a level name or an enum string.

Booleans are JSON `true` / `false` (not `"on"`). Enums must be one of the exact
strings listed in `get_device` — do not translate them. If the user says
"warm white", map it to the device's own enum value and say which one you used.

## What this cannot do

- No locks, no live camera streams, no firmware updates, and no `raw` /
  `bitmap` / `struct` / `array` properties. No pairing of a new device either:
  that is the Tuya app's job. Say so plainly rather than attempting a workaround.
- Unbinding an existing device is the one exception to "structure needs the app":
  `remove_device` does it, only with the advanced setting on and the id repeated,
  and only for as long as the user's key is allowed to manage the home. See
  [Removal is destructive](#removal-is-destructive--say-so-before-you-call-it).
- No live push. Commands are asynchronous: a successful `set_device` means Tuya
  accepted the command, not that the hardware has obeyed yet. If the user asks
  whether it worked, call `get_device` again a moment later.
- Device state is cloud state. A device that is offline in the Tuya cloud cannot
  be commanded, even if it is sitting on the local network.

## Failure handling

- `tuya_status` — run this first when the user says the plugin cannot connect. It
  reports which data centre was detected and how many homes the key can see, without
  exposing the key. Use `refresh: true` after a key or data-centre change.

- `AUTH` — key expired or wrong region. Two different problems share this code;
  the message says which. A region mismatch is fixed in the plugin settings
  (data centre), not by asking the user for a new key.
- `RATE_LIMITED` — the end-user API is throttled. Back off for a minute. Never
  loop over dozens of devices to "check everything".
- `DEVICE_OFFLINE` — report it as offline; do not retry in a loop.
- `NO_DATACENTRE` — no data centre accepted the key. Send the user to the
  plugin settings, not to the Tuya website.

## Working style

Control only what the user actually asked for, on the device they named. If two
devices match what they said, list the candidates with their room and ask —
do not pick one. When a request spans many devices, do it one device at a time
and report what succeeded, so a partial failure is visible instead of silent.
