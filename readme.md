# Winslow PS40 Pellet Stove Controller (Shelly Pro 4PM)

**Current Version:** v14.1 (Stable)  
**Hardware:** Shelly Pro 4PM + Shelly H&T Gen3  
**Language:** Shelly mJS (Micro-JavaScript)

## Project Overview
This project replaces the legacy/obsolete control board of a **Winslow PS40 Pellet Stove** (also known as Lennox or Country Stoves) with a modern, Wi-Fi-enabled **Shelly Pro 4PM** smart relay.

The controller manages the entire combustion cycle using a **Finite State Machine (FSM)**, handling ignition, fuel feed modulation, convection blowers, and safety shutdowns. It features a "Waterfall RPC" architecture to prevent network congestion on the Shelly device.

**v14.x** uses **proportional temperature control**: the auger feed rate scales continuously based on actual room temperature from a Shelly H&T Gen3 sensor. An asymmetric exponential moving average (EMA) smooths the feed rate -- slow to escalate (~14 min), fast to back off (~7 min) -- preventing overshoot from an oversized stove.

## Safety Warning
**DANGER:** This software controls fire and high-voltage components. 
- **DO NOT** use this software if you are not comfortable working with high-voltage electricity and combustion appliances.
- **ALWAYS** maintain physical safety interlocks (High-Limit Snap Disc, Vacuum Switch) wired in series where appropriate, or as independent inputs.
- The software includes safety timeouts, but **hardware failsafes are mandatory**.
- If the H&T sensor battery dies or temperature data becomes stale (>1 hour), the stove shuts down automatically.
- Use at your own risk. The author assumes no liability for damage or injury.

---

## Changelog

### v14.1 -- UI-Tunable Parameters
* **NEW: All operational parameters tunable from Shelly app.** Feed rates (LOW/HIGH bounds) and day/night schedule hours are now read from virtual Number components every heartbeat. No script redeployment needed to adjust.
    * `Number:203` (Low Fire ON) -- minimum auger ON, in seconds (default 2.5s)
    * `Number:204` (Low Fire OFF) -- minimum auger OFF, in seconds (default 5.5s)
    * `Number:205` (Day Start) -- hour when day schedule begins (default 8)
    * `Number:206` (Day End) -- hour when night schedule begins (default 22)
* **REMOVED: Boolean:201 (Night thermostat).** No longer needed. The schedule (day/night) combined with temperature thresholds handles all auto-restart logic. Simplifies Cloud Actions on the H&T -- only the temperature action URL is required.
* **CHANGED: Heartbeat now shows schedule.** Format: `S:8-22` (dayStart-dayEnd).

### v14.0 -- Proportional Temperature Control
* **NEW: EMA-smoothed proportional feed rate.** The auger duty cycle now scales continuously between LOW and HIGH bounds based on actual room temperature from Number:202 (pushed by H&T Gen3). Replaces the binary HIGH/LOW fire system.
    * `feedRatio` (0.0-1.0) is computed from temperature distance to day/night warm thresholds.
    * Asymmetric smoothing: `ALPHA_UP=0.08` (~14 min to 90%), `ALPHA_DOWN=0.15` (~7 min to 90%).
    * Minimum feed (`LOW_ON`/`LOW_OFF`) and maximum feed (`Number:200`/`Number:201`) are independently tunable.
* **NEW: Temperature staleness safety.** If Number:202 hasn't been updated in >1 hour, the stove shuts down to IDLE.
* **NEW: Temperature-based shutdown/restart.** Room temp at/above warm threshold starts a 30-min shutdown timer. Auto-restart from STANDBY when temp drops to cold threshold (4-degree hysteresis).
* Day band: 67-71F. Night band: 56-60F.

### v13.3 -- Cloud-Tunable Feed Rates
* HIGH fire ON/OFF timing read from `Number:200`/`Number:201` virtual components.

### v13.2 -- Purge-Safe Vacuum Failure
* On vacuum failure from PURGING state, `stopStove()` resumes a clean purge instead of going to IDLE.

### v13.1 -- Vacuum Pre-Flight Fix
* Start exhaust fan first, wait `T_VAC_SETTLE` (5s), then check vacuum switch.

### v13.0 -- Thermostat Auto-Control
* Room thermostat via Shelly H&T Gen3. Day/night schedules, STANDBY state, auto-restart.

### v12.1 -- Phantom Shutdown Fix
* Clear purge timer on Start to prevent phantom shutdown 10 min after boot.

---

## Hardware Configuration

### Wiring Map (Shelly Pro 4PM)

| Channel | Component | Function | Notes |
| :--- | :--- | :--- | :--- |
| **Output 0** | Exhaust Fan | Vents smoke/fumes | Default ON state recommended for safety. |
| **Output 1** | Igniter | Heats pellets for start | Active only during `PRIME` and `IGNITE` phases. |
| **Output 2** | Auger Motor | Feeds fuel | Duty cycle scales with temperature (EMA-smoothed). |
| **Output 3** | Convection Fan | Room air blower | Activates after ignition to distribute heat. |

### Inputs (Add-on / Switch Terminals)

| Input ID | Component | Type | Function |
| :--- | :--- | :--- | :--- |
| **Input 0** | STOP Button | Momentary (Push) | Triggers `stopStove()` (Purge Mode). |
| **Input 1** | START Button | Momentary (Push) | Triggers `startStartup()` sequence. |
| **Input 2** | POF Snap Disc | Toggle (Switch) | **Proof of Fire.** Closed = Hot, Open = Cold. |
| **Input 3** | Vacuum Switch | Toggle (Switch) | Safety pressure sensor. Must be Closed to run. |

---

## Software Features

### 1. Proportional Temperature Control
The H&T Gen3 sensor pushes the room temperature to `Number:202` on the Pro 4PM via a local HTTP action (`/rpc/number.set?id=202&value=${ev.tF}`). Each heartbeat (30s), the script:
1. Reads the temperature and computes a **target ratio** from the active day/night band.
2. Applies an **asymmetric EMA** -- slow to ramp up (prevents overshoot), fast to back off.
3. Interpolates auger ON/OFF timing between the LOW floor and HIGH ceiling.

### 2. Waterfall RPC Architecture
The Shelly Pro 4PM has a limit of 5 concurrent RPC calls. Relays are toggled one by one in a serialized chain to prevent "Too Many Calls" errors.

### 3. Finite State Machine
- **IDLE:** Fully off. Requires manual Start to begin.
- **STARTUP:** PRIME -> WAIT -> RAMP -> fire check.
- **RUNNING:** Proportional feed based on room temperature.
- **PURGING:** Cool-down. Manual/safety: 30 min -> IDLE. Thermostat: 15 min -> STANDBY.
- **STANDBY:** Off but eligible for auto-restart when room cools to cold threshold.

### 4. Event-Driven Safety
- **Vacuum Loss:** >10s open -> emergency shutdown.
- **Fire Loss:** >60s cold during run -> shutdown.
- **Temp Staleness:** >1 hour without update -> shutdown to IDLE.

---

## Virtual Components

| Type | ID | Name | Description |
| :--- | :--- | :--- | :--- |
| `Number:200` | High Fire ON | Auger ON ceiling in seconds. Default 4.5s. |
| `Number:201` | High Fire OFF | Auger OFF ceiling in seconds. Default 3.5s. |
| `Number:202` | Temperature | Room temp from H&T Gen3 (pushed via sensor action URL). |
| `Number:203` | Low Fire ON | Auger ON floor in seconds. Default 2.5s. |
| `Number:204` | Low Fire OFF | Auger OFF floor in seconds. Default 5.5s. |
| `Number:205` | Day Start | Hour when day schedule begins (0-23). Default 8. |
| `Number:206` | Day End | Hour when night schedule begins (0-23). Default 22. |
| `Button:200` | Start Stove | Triggers startup sequence. |
| `Button:201` | Stop Stove | Triggers shutdown. |
| `Button:202` | Force Run | Bypass ignition, go directly to RUNNING. |

## Tunable Parameters (via Shelly App or hardcoded defaults)

| Parameter | Virtual Component | Default | Description |
| :--- | :--- | :--- | :--- |
| High Fire ON | Number:200 | 4.5s | Maximum auger ON time (ceiling) |
| High Fire OFF | Number:201 | 3.5s | Maximum auger OFF time (ceiling) |
| Low Fire ON | Number:203 | 2.5s | Minimum auger ON time (floor) |
| Low Fire OFF | Number:204 | 5.5s | Minimum auger OFF time (floor) |
| Day Start | Number:205 | 8 | Hour when day schedule begins |
| Day End | Number:206 | 22 | Hour when night schedule begins |

### Hardcoded Parameters (in script.js)

| Constant | Default | Description |
| :--- | :--- | :--- |
| `DAY_COLD` | 67F | Full HIGH fire target (day) |
| `DAY_WARM` | 71F | Minimum feed / shutdown threshold (day) |
| `NIGHT_COLD` | 56F | Full HIGH fire target (night) |
| `NIGHT_WARM` | 60F | Minimum feed / shutdown threshold (night) |
| `ALPHA_UP` | 0.08 | EMA up-ramp speed (~14 min to 90%) |
| `ALPHA_DOWN` | 0.15 | EMA down-ramp speed (~7 min to 90%) |
| `TEMP_MAX_AGE` | 3600s | Max seconds before temp data is stale |

---

## H&T Gen3 Configuration

Only one Cloud Action is required on the H&T Gen3:

**Temperature Sensor Action:**
- URL: `http://192.168.0.40/rpc/number.set?id=202&value=${ev.tF}`
- Triggers on temperature change, pushing the room temp to the Pro 4PM.

All other Cloud Actions (Day Heating, Night Heating, etc.) can be deleted -- they are no longer needed with temperature-based control.

---

## License
MIT License. Free to use, modify, and distribute.
