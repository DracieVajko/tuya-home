# Tuya Home

Control the devices already in your Tuya / Smart Life account from Cindy: list
homes and rooms, read what a device is doing, switch it, set brightness,
temperature or mode, rename it.

An optional, **off-by-default** advanced setting adds three home-structure tools.
One of them, `remove_device`, **unbinds a device from your Tuya account
permanently** — it leaves the Tuya app and has to be paired again to come back.
Everything about it is spelled out in
[Advanced — home structure](#advanced--home-structure-off-by-default) below.

Your Tuya API key is handed to Cindy's vault the moment you paste it. The plugin
never stores it, never logs it, and the model never sees it — Cindy injects it
into requests to Tuya's API hosts only.

## Setup

1. Create a Tuya account (the same one used in the Smart Life / Tuya app) and get
   an **end-user API key** (`sk-...`):
   - Developer portal: https://tuya.ai/developer
   - API reference: https://tuya.ai/developer/docs
   - China mainland accounts: https://tuyasmart.com/
2. Open the plugin settings and paste the key.
3. Press **Test connection**. It reports which data centre answered and how many
   homes the key can see.
4. Open the left sidebar panel to see the devices grouped by home and room, use
   the power button on devices that expose a switch, or just ask in chat:
   *"which lights are on?"*, *"turn off the desk lamp"*, *"set the bedroom AC to 24"*.

Keys are region-bound: Tuya routes a key only to the data centre where the
account is registered, and the prefix after `sk-` says which one. **This plugin
never sees the key value**, so it cannot read that prefix: it asks the remembered
centre first, then the others in turn, and keeps the one that answered. If your
account is locked to a region and detection fails, pin the data centre in the
settings.

## Command reference

`COMMANDS.md` lists the tools, the common Tuya property codes and worked example
commands. The real names, ids, ranges and current values of your own devices are
never bundled: `list_devices` and `get_device` read them from your account.

## Advanced — home structure (off by default)

The plugin ships three extra tools that are **off by default** and stay refused
until you tick *Advanced — home structure* in the settings:

| Tool | What it does | What it changes |
|---|---|---|
| `create_room` | Creates a room in a home | Visible in the Tuya app |
| `assign_device_room` | Moves one device into a room | Visible in the Tuya app |
| `remove_device` | **Unbinds (removes) a device from the Tuya cloud and the account** | **Permanent.** The device leaves the Tuya app and must be paired again to return |

### `remove_device` — conditions, permission, impact

**When it can run.** All four conditions must hold, otherwise nothing is sent to
Tuya:

1. *Advanced — home structure* is ticked in the plugin settings (it is unticked
   on install, and unticking it blocks the tool again immediately);
2. the assistant calls `remove_device`, and only after you named the device;
3. the call carries `device_id` **and** `confirm_device_id` with exactly the same
   value — a display name is not accepted as proof, because two devices in one
   home are often called the same thing;
4. the saved key is allowed to manage this home.

**Permission it needs.** `remove_device` is a Smart Home call (`DELETE
/v1.0/devices/{id}`), not an end-user read. A normal end-user key (`sk-`) is
**refused** by Tuya — `1010` on the Smart Home family, `1108` on the end-user
one — and the plugin reports that refusal without retrying. Reading state,
switching devices, setting values and renaming all keep working on the same key.

**What it does to your account.** The device is unbound: it is removed from your
Tuya account and from the Tuya / Smart Life app. Expect it to drop off your Wi-Fi
or gateway, and expect scenes and automations in the Tuya app that pointed at it
to stop controlling anything. This cannot be undone from the plugin — there is
no "restore" call. To get the device back you have to put it into pairing mode
and add it again in the Tuya app, then recreate its scenes, rooms and
automations. Do that in the Tuya app; this plugin has no pairing support.

We could not verify the last step end to end: an `sk-` key is refused before the
device is touched, so the successful path needs a key that is allowed to manage
the home. The plugin is written for it, and it reports a refusal as a refusal.

**What the setting never affects:** reading device state, switching devices,
setting values, and renaming.

## What it does not do

- **No locks.** Unlocking doors is deliberately out of reach of this API.
- **No pairing of new devices.** Adding a device, putting it into pairing mode and
  recreating its scenes is the Tuya app's job.
- **No live camera view.** Cloud snapshots exist in Tuya's API, but this plugin
  only covers device state and control.
- **No firmware updates.**
- **No raw / bitmap / struct properties.** Only switches, numbers, enums and text.
- **No live push.** Cindy's network layer cannot hold a WebSocket open, so state
  is read when you refresh the panel or ask a question. Commands are
  asynchronous: Tuya accepting a command is not the same as the device obeying it.
  Re-read the device to confirm.

Unbinding an existing device *is* possible, and only in the gated way described
above: advanced setting on, `device_id` repeated, key allowed to manage the home.
Nothing else in the plugin removes, deletes or unpairs anything.

## Good to know

- Numbers live inside each device's own declared range, which `get_device` reports.
  Air conditioners usually say 16–30 (decimals allowed); lights usually say 10–1000,
  so half brightness is `500`. The plugin converts to Tuya's raw integers — never
  pre-scale a value yourself.
- The power button in the panel only works on devices that expose a switch code
  (`switch`, `switch_1`, `switch_1_1`, `switch_led`); anything else answers with
  the reason it cannot be switched instead of guessing a property.
- `get_device` prints at most 24 state entries and 24 writable properties in its
  summary. The `state` and `writable` arrays in the same answer are complete, so
  a device with more properties loses nothing — read the arrays.
- Tuya's end-user API is in a trial phase with unpublished rate limits, so the
  plugin keeps requests countable: one write is one call once the device model is
  cached (the model is fetched once and kept for an hour), listing a home costs
  one call for its rooms plus one for its devices, and the device list is cached
  for 20 seconds. Avoid scripting sweeps across every device.
- Device state shown here is the state in Tuya's cloud. A device that is offline
  in the cloud cannot be commanded even if it is on your LAN.

## Privacy

- The plugin talks to exactly seven hosts: `openapi.tuyacn.com`, `openapi.tuyaus.com`,
  `openapi.tuyaeu.com`, `openapi.tuyain.com`, `openapi-ueaz.tuyaus.com`,
  `openapi-weaz.tuyaeu.com`, `openapi-sg.iotbing.com`. Nothing else.
- No analytics, no telemetry, no third-party service.
- What it stores is not secret: the detected data centre, the pinned data centre,
  and whether the advanced setting is on. The key itself lives in Cindy's vault
  and can be removed on the settings page — do that, or revoke it with Tuya, if
  you stop using the plugin.
