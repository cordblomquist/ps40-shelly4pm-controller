# Winslow PS40 Pellet Stove Controller (Shelly Pro 4PM)

**Current Version:** v12.1 (Stable)  
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

## v12.1 Changelog (Latest)
* **FIXED: The "Phantom Shutdown" Bug.** * *Issue:* In v12.0, the safety shutdown timer (`stopStove(600)`) initiated at boot would persist even after the user pressed "Start." This caused the stove to seemingly randomly shut down exactly 10 minutes after the device booted, regardless of the fire state.
    * *Fix:* The `startStartup()` sequence and `Force Run` event now explicitly call `Timer.clear()` on the global purge timer to ensure no background countdowns remain active during a burn.

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
- **IDLE:** Waiting for command.
- **STARTUP:**
    - `PRIME`: Load initial pellets.
    - `WAIT`: Pause feed to build ember bed.
    - `IGNITE`: Igniter ON, Feed ON (Ramp).
    - `RAMP`: Wait for Proof of Fire (POF) snap disc to close.
- **RUNNING:** Normal operation. Auger cycles based on heat settings.
- **PURGING:** Cool-down cycle. Fans run for 30 minutes (or custom time) to burn off fuel.

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
- `Boolean:200`: Virtual Thermostat (High/Low Fire).
- `Button:200`: Virtual Start.
- `Button:201`: Virtual Stop.
- `Button:202`: Force Run (Bypass Ignition).

---

## License
MIT License. Free to use, modify, and distribute.
