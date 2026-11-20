# Tuya Home — commands and automation

Generic reference: the plugin's tools, the common Tuya property codes and worked
examples. Codes differ between devices, so always confirm them with `get_device`
before writing.

## Plugin tools

| Tool | What it does |
|---|---|
| `tuya_status` | Diagnostic: which data centre was detected, whether the key works, how many homes it can see. Use it first when the connection fails. |
| `list_homes` | Homes and their rooms. |
| `list_devices` | Devices (filters: `home_id`, `room_id`, `refresh`). |
| `get_device(device_id)` | Current state plus writable properties, with types, ranges and units. |
| `set_device(device_id, {code: value})` | Writes properties. Validated locally before anything is sent. |
| `rename_device(device_id, "name")` | Renames a device (1–40 characters). |
| `create_room("name")` | Creates a room; the same name returns the existing room with `created: false`. Advanced, off by default. |
| `assign_device_room(device_id, room_id)` | Moves one device into a room. Advanced, off by default. |
| `remove_device(device_id, confirm_device_id)` | Unbinds a device from the cloud and the account — permanent. Advanced, off by default. |

## Automation pattern

1. `list_devices` → `device_id`, name, online state.
2. `get_device(device_id)` → current values and the writable codes with ranges.
3. `set_device(device_id, {"code": value})` → write.
4. Across several devices: one at a time, and report each result.

Rules:
- Values must sit inside the range `get_device` reports.
- Booleans are JSON `true` / `false`, not `"on"`.
- Enums are the exact string from the list.
- An offline device cannot be commanded.
- `set_device` means Tuya accepted the command, not that the hardware has obeyed
  it; confirm with `get_device`.

## Common Tuya property codes (examples; always confirm with get_device)

### Switches / plugs / boilers
- `switch`, `switch_1`, `switch_2`, `switch_led` — bool — on/off
- `switch_type` — enum — `flip | sync | button`
- `relay_status` — enum — `off | on | memory` (state after power returns)
- `switch_backlight` — bool — backlight
- `switch_inching` — string — inching (pulse) mode
- `countdown`, `countdown_1` — value 0–86400 (s) — countdown
- `random_time`, `cycle_time` — string — random / cyclic timer

### Lights
- `switch_led` — bool
- `bright_value` — value (often 10–1000) — brightness
- `temp_value` — value (often 0–1000) — colour temperature
- `work_mode` — enum — `white | colour | scene | music`

### EV chargers
- `switch` — bool — on/off
- `work_mode` — enum — `charge_now | charge_pct | charge_energy | charge_schedule`
- `ChargingOperation` — enum — `OpenCharging | CloseCharging | WaitOperation`
- `Set10A`, `Set12A`, `Set13A`, `Set16A`, `Set32A`, `Set40A`, `Set50A`, `Set80A` — value — current limits
- `SetDelayTime`, `SetDefineTime` — value 0–15
- `RFID`, `IDVerificationSet` — bool
- `online_state` — enum — `online | offline`
- `clear_energy` — bool — clear energy
- `balance_energy`, `charge_energy_once`, `device_kw`, `device_kwh`, `work_state`, `device_state` — status values

### Energy meters
- `switch` — bool
- `power_total`, `power_total1` — value — power
- `voltage_a/b/c`, `current_a/b/c` — value
- `over_voltage`, `low_voltage`, `over_current`, `over_power`, `over_energy`, `over_temp` — value — limits
- `energy_clear`, `runtime_clear` — bool
- `countdown` — value 0–86400
- `panel_state`, `screen_poweroff` — bool/value
- `run_time`, `engery`, `engery_a/b/c`, `forward_energy_total` — value

### Robot vacuums
- `switch_go` — bool — start/stop
- `pause` — bool
- `switch_charge` — bool
- `mode` — enum — `smart | chargego | zone | pose | part | edge | explore | exploreclean`
- `suction` — enum — `strong | normal | gentle | max | closed`
- `cistern` — enum — `low | middle | high | closed`
- `seek` — bool
- `direction_control` — enum — `foward | backward | turn_left | turn_right | stop`
- `reset_map`, `reset_edge_brush`, `reset_roll_brush`, `reset_filter` — bool
- `switch_disturb` — bool
- `volume_set` — value 0–10
- `break_clean`, `auto_boost`, `dust_collection_switch`, `y_mop`, `clean_edge_brush`, `clean_roll_brush`, `clean_filter` — bool
- `Schedule1..Schedule7` — string
- `reset_map`, `SaveMap`, `CleanPartitionData`, `CleanSettings`, `MapRoomInfo1..3` — string/value

### Cameras
- `motion_switch` — bool
- `motion_sensitivity` — enum — `0 | 1 | 2`
- `motion_record`, `motion_tracking` — bool
- `nightvision_mode` — enum — `auto | ir_mode | color_mode`
- `basic_flip`, `basic_osd`, `basic_wdr`, `basic_nightvision` — bool/enum
- `basic_device_volume` — value 1–10
- `ptz_control` — enum — `0..9`
- `ptz_stop`, `ptz_calibration` — bool
- `record_switch`, `record_mode` — bool/enum
- `sd_format` — bool
- `device_restart` — bool
- `humanoid_filter`, `cruise_switch` — bool
- `cruise_mode` — enum — `0 | 1`
- `memory_point_set` — string
- `ipc_work_mode` — enum — `0 | 1`
- `wireless_awake`, `wireless_lowpower` — bool/value

### Batteries / power tools
- `security_switch`, `upper_temp_switch`, `battery_finder`, `lamp_swtich`, `cw_or_ccw_control`, `kick_back_swtich`, `laser_switch`, `laser_pulse_switch` — bool
- `battery_work_mode` — enum — `Performance | Balanced | Endurance | Expert`
- `pack_work_mode` — enum — `Performance | Balanced | Expert | ECO`
- `battery_pin` — string
- `discharging_current`, `discharge_curr_limit`, `tools_current`, `mini_tools_current` — value
- `lamp_brig_percentage` — value 1–100
- `lamp_delay_time` — value 1–99
- `speed_percentage` — value 1–100
- `battery_temp_current` — value -25–85
- `tool_rotation_speed`, `tool_torque` — value
- `timer_shutdown` — value 0–65535

### ATORCH tester
- `fun_sel` — enum — `CC | CV | CR | CP | BRT | PT | CRT | D_C_D | ...`
- `run_set` — value 0–100000
- `temp_rw` — value -0.01–99.59
- `m_rw`, `l_rw` — value
- `cur_batter` — enum (battery types)
- `ex_ctl`, `fan_ctl`, `fw_ctl`, `bl_rw` — value
- `child_lock` — bool

## Safety

- Never drive locks; the plugin does not expose them at all.
- Confirm a destructive action with the user first.
- An offline device rejects the command; do not retry in a loop.
- The API is in trial with rate limits: one write is one POST once the device
  model is cached.

## Your own devices

This package carries no device list. Your names, ids, categories, current values
and writable properties come from the account itself:

1. `list_devices` — homes, rooms, devices, `device_id`, online state.
2. `get_device(device_id)` — current values plus the accepted properties and ranges.
3. `set_device(device_id, { "code": value })` — write inside the range from `get_device`.

Codes and ranges differ from device to device, so never derive a value from the
tables above — always read `get_device`.
