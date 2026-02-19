# Winslow PS40 Pellet Stove Controller (Shelly Pro 4PM)

**Current Version:** v14.0 (Stable)  
**Hardware:** Shelly Pro 4PM + Shelly H&T Gen3  
**Language:** Shelly mJS (Micro-JavaScript)

## Project Overview
This project replaces the legacy/obsolete control board of a **Winslow PS40 Pellet Stove** (also known as Lennox or Country Stoves) with a modern, Wi-Fi-enabled **Shelly Pro 4PM** smart relay.

The controller manages the entire combustion cycle using a **Finite State Machine (FSM)**, handling ignition, fuel feed modulation, convection blowers, and safety shutdowns. It features a "Waterfall RPC" architecture to prevent network congestion on the Shelly device.

**v14.0** introduces **proportional temperature control**: instead of binary HIGH/LOW fire, the auger feed rate scales continuously based on the actual room temperature reported by a Shelly H&T Gen3 sensor. An asymmetric exponential moving average (EMA) smooths the feed rate -- slow to escalate (~14 min), fast to back off (~7 min) -- preventing overshoot from an oversized stove.

## Safety Warning
**DANGER:** This software controls fire and high-voltage components. 
- **DO NOT** use this software if you are not comfortable working with high-voltage electricity and combustion appliances.
- **ALWAYS** maintain physical safety interlocks (High-Limit Snap Disc, Vacuum Switch) wired in series where appropriate, or as independent inputs.
- The software includes safety timeouts, but **hardware failsafes are mandatory**.
- If the H&T sensor battery dies or temperature data becomes stale (>1 hour), the stove shuts down automatically.
- Use at your own risk. The author assumes no liability for damage or injury.

---

## Changelog

### v14.0 -- Proportional Temperature Control
* **NEW: EMA-smoothed proportional feed rate.** The auger duty cycle now scales continuously between LOW and HIGH bounds based on actual room temperature from Number:202 (pushed by H&T Gen3). Replaces the binary HIGH/LOW fire system.
    * `feedRatio` (0.0-1.0) is computed from temperature distance to day/night warm thresholds.
    * Asymmetric smoothing: `ALPHA_UP=0.08` (~14 min to 90%), `ALPHA_DOWN=0.15` (~7 min to 90%).
    * Minimum feed (`LOW_ON`/`LOW_OFF`) and maximum feed (`Number:200`/`Number:201`) are independently tunable.
* **NEW: Temperature staleness safety.** If Number:202 hasn't been updated in >1 hour, the stove shuts down to IDLE (Rinnai propane backup available).
* **NEW: Temperature-based shutdown/restart.** Room temp at/above warm threshold starts a 30-min shutdown timer. Auto-restart from STANDBY when temp drops to cold threshold (4-degree hysteresis).
* **RETIRED: Boolean:200 (Day thermostat).** Replaced by direct temperature reading from Number:202.
* **KEPT: Boolean:201 (Night thermostat).** Serves as night-mode enable/disable gate for auto-restart.
* Day band: 67-71F. Night band: 56-60F.

### v13.3 -- Cloud-Tunable Feed Rates
* HIGH fire ON/OFF timing read from `Number:200`/`Number:201` virtual components.
* Adjustable from the Shelly app without redeploying the script.

### v13.2 -- Purge-Safe Vacuum Failure
* On vacuum failure from PURGING state, `stopStove()` resumes a clean purge instead of going to IDLE.

### v13.1 -- Vacuum Pre-Flight Fix
* Start exhaust fan first, wait `T_VAC_SETTLE` (5s), then check vacuum switch. Fixes "Vacuum OPEN" failure on cold start and STANDBY auto-restart.

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

### 1. Proportional Temperature Control (v14.0)
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

| Type | ID | Description |
| :--- | :--- | :--- |
| `Boolean:201` | Night Thermostat | Cloud-driven. `true` = heat needed (<58F). Gates nighttime auto-restart. |
| `Number:200` | HIGH Fire ON | Auger ON ceiling in seconds. Default 4.5s. |
| `Number:201` | HIGH Fire OFF | Auger OFF ceiling in seconds. Default 3.5s. |
| `Number:202` | Room Temperature | Pushed by H&T Gen3 via sensor action URL. Drives proportional control. |
| `Button:200` | Virtual Start | Triggers startup sequence. |
| `Button:201` | Virtual Stop | Triggers shutdown. |
| `Button:202` | Force Run | Bypass ignition, go directly to RUNNING. |

## Tunable Parameters (top of script.js)

| Constant | Default | Description |
| :--- | :--- | :--- |
| `LOW_ON` | 2500 ms | Minimum auger ON time (floor of proportional range) |
| `LOW_OFF` | 5500 ms | Minimum auger OFF time (floor of proportional range) |
| `DAY_COLD` | 67F | Full HIGH fire target (day) |
| `DAY_WARM` | 71F | Minimum feed / shutdown threshold (day) |
| `NIGHT_COLD` | 56F | Full HIGH fire target (night) |
| `NIGHT_WARM` | 60F | Minimum feed / shutdown threshold (night) |
| `ALPHA_UP` | 0.08 | EMA up-ramp speed (~14 min to 90%) |
| `ALPHA_DOWN` | 0.15 | EMA down-ramp speed (~7 min to 90%) |
| `TEMP_MAX_AGE` | 3600 s | Max seconds before temp data is stale |

---

## License
MIT License. Free to use, modify, and distribute.
