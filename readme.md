# Winslow PS40 Pellet Stove Controller (Shelly Pro 4PM)

**Current Version:** v13.1 (Stable)  
**Hardware:** Shelly Pro 4PM  
**Language:** Shelly mJS (Micro-JavaScript)

## Project Overview
This project replaces the legacy/obsolete control board of a **Winslow PS40 Pellet Stove** (also known as Lennox or Country Stoves) with a modern, Wi-Fi-enabled **Shelly Pro 4PM** smart relay.

The controller manages the entire combustion cycle using a **Finite State Machine (FSM)**, handling ignition, fuel feed modulation, convection blowers, and safety shutdowns. It features a "Waterfall RPC" architecture to prevent network congestion on the Shelly device.

## 🚨 Safety Warning
**DANGER:** This software controls fire and high-voltage components. 
- **DO NOT** use this software if you are not comfortable working with high-voltage electricity and combustion appliances.
- **ALWAYS** maintain physical safety interlocks (High-Limit Snap Disc, Vacuum Switch) wired in series where appropriate, or as independent inputs.
- The software includes safety timeouts, but **hardware failsafes are mandatory**.
- Use at your own risk. The author assumes no liability for damage or injury.

---

## Changelog

### v13.1 — Vacuum Pre-Flight Fix
* **FIXED: "Vacuum OPEN. Cannot Start." on cold start and STANDBY auto-restart.**
    * *Issue:* The pre-flight check read the vacuum switch before the exhaust fan was running. Since the vacuum switch requires negative pressure (airflow) to close, it always read OPEN when starting from a cold/idle state — especially on thermostat auto-restart from STANDBY.
    * *Fix:* `startStartup()` now turns on the exhaust fan first, waits `T_VAC_SETTLE` (5s) for pressure to establish, then checks the vacuum switch. On failure, the exhaust fan is shut back off and the stove returns to IDLE.

### v13.0 — Thermostat Auto-Control
* **NEW: Room thermostat via Shelly H&T Gen3.** Day/night schedules (8 AM–10 PM / 10 PM–8 AM) with independent temperature ranges. Automatic HIGH/LOW fire adjustment based on room temperature.
* **NEW: STANDBY state.** After a thermostat-initiated shutdown (15-min purge), the stove enters STANDBY and auto-restarts when the room needs heat again.
* **NEW: Thermostat purge cancellation.** If the room cools during a thermostat purge, the purge is cancelled and a full startup begins.

### v12.1 — Phantom Shutdown Fix
* **FIXED: The "Phantom Shutdown" Bug.** The safety shutdown timer (`stopStove(600)`) initiated at boot would persist after Start was pressed, causing a shutdown exactly 10 minutes after boot. `startStartup()` and Force Run now explicitly clear the purge timer.

---

## Hardware Configuration

### Wiring Map (Shelly Pro 4PM)

| Channel | Component | Function | Notes |
| :--- | :--- | :--- | :--- |
| **Output 0** | Exhaust Fan | Vents smoke/fumes | Default ON state recommended for safety. |
| **Output 1** | Igniter | Heats pellets for start | Active only during `PRIME` and `IGNITE` phases. |
| **Output 2** | Auger Motor | Feeds fuel | PWM-style duty cycle (e.g., 3s ON / 5s OFF). |
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

### 1. Waterfall RPC Architecture
The Shelly Pro 4PM has a limit of 5 concurrent RPC calls. To prevent "Too Many Calls" errors during complex state changes (like startup or shutdown), this script uses a **Waterfall** approach. 
- Relays are toggled one by one in a serialized chain (Callback Hell style).
- Ensure Relay A is confirmed ON before attempting to turn Relay B ON.

### 2. Finite State Machine
The stove operates in distinct states:
- **IDLE:** Fully off. Requires manual Start to begin.
- **STARTUP:**
    - `PRIME`: Exhaust fan starts, vacuum verified, then igniter + auger feed begin.
    - `WAIT`: Pause feed to build ember bed.
    - `RAMP`: Feed resumes. Waiting for Proof of Fire (POF) snap disc to close.
- **RUNNING:** Normal operation. Auger cycles based on thermostat signal (HIGH/LOW fire).
- **PURGING:** Cool-down cycle. Manual/safety: 30 min → IDLE. Thermostat: 15 min → STANDBY.
- **STANDBY:** Stove is off but eligible for thermostat auto-restart.

### 3. Event-Driven Safety
Instead of polling the hardware constantly, the script listens for events:
- **Vacuum Loss:** If the vacuum switch opens for >10 seconds, the stove performs an emergency shutdown.
- **Fire Loss:** If the POF switch opens during a run for >60 seconds, the stove shuts down.

---

## Installation

1.  **Mount:** Install the Shelly Pro 4PM on a DIN rail.
2.  **Wire:** Connect components according to the wiring map above.
3.  **Config:**
    * Set **Input 0** & **Input 1** to `Button` mode.
    * Set **Input 2** & **Input 3** to `Switch` mode.
4.  **Script:**
    * Open the Shelly Web Interface (IP address in browser).
    * Go to **Scripts** > **Add Script**.
    * Paste the content of `script.js` from this repo.
    * **Enable** the script and click **Start**.

## Virtual Components (Optional)
The script supports Shelly Virtual Components for UI control:
- `Boolean:200`: Day Thermostat — Cloud-driven. `true` = room needs heat (<68°F), `false` = warm enough (>72°F).
- `Boolean:201`: Night Thermostat — Cloud-driven. `true` = room needs heat (<55°F), `false` = warm enough (>60°F).
- `Button:200`: Virtual Start.
- `Button:201`: Virtual Stop.
- `Button:202`: Force Run (Bypass Ignition).

---

## License
MIT License. Free to use, modify, and distribute.
