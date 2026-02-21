# Winslow PS40 Pellet Stove Controller (Shelly Pro 4PM)

**Current Version:** v14.8 (Stable)  
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

### v14.8 -- Fix Fans On in Standby
* **FIX:** Fixed a bug introduced in v14.4 where pressing Start during a boot purge (when the room is warm) would cancel the purge timer but fail to turn off the relays, leaving the exhaust and convection fans running indefinitely in `STANDBY` mode. It now properly turns off the fans if the stove is cold, or lets the purge finish before entering `STANDBY` if the stove is hot.

### v14.7 -- Slower Feed Ramp Up
* **CHANGED:** Decreased `ALPHA_UP` from `0.08` to `0.04` to slow down the Exponential Moving Average (EMA) ramp-up. It now takes ~29 minutes to reach 90% of the target feed rate, up from ~14 minutes. This results in longer, lower burns rather than quickly ramping up to a hot fire.

### v14.6 -- Reduced High Feed Rate Again
* **CHANGED:** Reduced HIGH feed rate bounds again (`HIGH_ON: 3500ms`, `HIGH_OFF: 4500ms`) to prevent the stove from getting too hot to the touch. Ratio is now ~1.4x.

### v14.5 -- Standby on Start & Reduced High Feed Rate
* **NEW:** Pressing Start when the room is already above the cold threshold now puts the stove directly into `STANDBY` instead of running the ignition sequence.
* **FIX:** Purge timers are properly cleared when entering Standby via the Start button to prevent phantom shutdown to IDLE.
* **CHANGED:** Reduced HIGH feed rate bounds (`HIGH_ON: 4500ms`, `HIGH_OFF: 3500ms`) to prevent over-feeding. Ratio is now ~1.8x.
* **CHANGED:** Local python logger `stove-logger.py` updated to filter out noisy RPC logs, leaving only clear script outputs.

### v14.2 -- Simplified Feed & Tunable Temperature Bands
* **NEW: Feed rates hardcoded per PS40 spec.** LOW: 2500ms ON / 5500ms OFF. HIGH: 6500ms ON / 1500ms OFF (~2.5x ratio). Removes 4 Number components.
* **NEW: Tunable temperature bands via Shelly app.**
    * `Number:200` (Day Cold) -- restart threshold for daytime (default 67F)
    * `Number:201` (Night Cold) -- restart threshold for nighttime (default 56F)
    * `Number:203` (Hysteresis) -- degrees above cold for warm/shutdown threshold (default 4F)
    * Warm = Cold + Hysteresis. Day: 67-71F. Night: 56-60F with defaults.
* **CHANGED: Heartbeat shows temperature bands.** Format: `D:67-71 N:56-60`.
* **REMOVED:** Number:200-201 (feed timing), Number:203-204 (low fire). Now hardcoded.

### v14.1 -- UI-Tunable Parameters
* All operational parameters tunable from Shelly app (feed rates, schedule hours).
* Removed Boolean:201 (Night thermostat) -- temperature + schedule handles everything.

### v14.0 -- Proportional Temperature Control
* EMA-smoothed proportional feed rate based on room temperature from Number:202.
* Asymmetric smoothing: slow to escalate, fast to back off.
* Temperature staleness safety (>1 hour without update -> shutdown).

### v13.x -- Earlier Versions
* v13.3: Cloud-tunable HIGH fire rates.
* v13.2: Purge-safe vacuum failure handling.
* v13.1: Exhaust-first vacuum check.
* v13.0: Thermostat auto-control via H&T Gen3.

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
3. Interpolates auger ON/OFF timing between the hardcoded LOW floor and HIGH ceiling.

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

| Type | ID | Name | Range | Default | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Number:200` | Day Cold | 45-75F | 67F | Restart threshold (day). Warm = Cold + Hysteresis. |
| `Number:201` | Night Cold | 45-75F | 56F | Restart threshold (night). Warm = Cold + Hysteresis. |
| `Number:202` | Temperature | 50-80F | — | Room temp from H&T Gen3 (pushed via sensor action). |
| `Number:203` | Hysteresis | 1-5F | 4F | Degrees above cold for warm/shutdown threshold. |
| `Number:205` | Day Start | 0-23 | 8 | Hour when day schedule begins. |
| `Number:206` | Day End | 0-23 | 22 | Hour when night schedule begins. |
| `Button:200` | Start Stove | — | — | Triggers startup sequence. |
| `Button:201` | Stop Stove | — | — | Triggers shutdown. |
| `Button:202` | Force Run | — | — | Bypass ignition, go directly to RUNNING. |
| `Group:200` | Stove Controls | — | — | Groups components in Shelly web UI. |

**Total:** 10 components (at limit)

## Tunable Parameters (via Shelly App)

| Parameter | Virtual Component | Default | Description |
| :--- | :--- | :--- | :--- |
| Day Cold | Number:200 | 67F | Full fire target / restart threshold (day) |
| Night Cold | Number:201 | 56F | Full fire target / restart threshold (night) |
| Hysteresis | Number:203 | 4F | Warm = Cold + this. Controls temperature swing. |
| Day Start | Number:205 | 8 | Hour when day schedule begins |
| Day End | Number:206 | 22 | Hour when night schedule begins |

### Hardcoded Parameters (in script.js)

| Constant | Value | Description |
| :--- | :--- | :--- |
| `LOW_ON` | 2500ms | Minimum auger ON (floor) |
| `LOW_OFF` | 5500ms | Minimum auger OFF (floor) |
| `HIGH_ON` | 3500ms | Maximum auger ON (ceiling) |
| `HIGH_OFF` | 4500ms | Maximum auger OFF (ceiling) |
| `ALPHA_UP` | 0.04 | EMA up-ramp speed (~29 min to 90%) |
| `ALPHA_DOWN` | 0.15 | EMA down-ramp speed (~7 min to 90%) |
| `TEMP_MAX_AGE` | 3600s | Max seconds before temp data is stale |

---

## H&T Gen3 Configuration

Only one sensor action is required on the H&T Gen3:

**Temperature Sensor Action:**
- URL: `http://192.168.0.40/rpc/number.set?id=202&value=${ev.tF}`
- Triggers on temperature change, pushing the room temp to the Pro 4PM.

All Cloud Actions (Day Heating, Night Heating, etc.) can be deleted -- they are no longer needed.

---

## License
MIT License. Free to use, modify, and distribute.
