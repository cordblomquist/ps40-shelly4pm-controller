# Winslow PS40 Pellet Stove Controller (Shelly Pro 4PM)

**Current Version:** v12.0 (Stable / Event-Driven)

This project replaces the obsolete or failing factory control board of a **Winslow PS40 Pellet Stove** (also known as Lennox/IronStrike/Country Stoves) with a **Shelly Pro 4PM** smart relay running custom firmware logic.

It converts the stove into a fully modern, Wi-Fi-connected IoT appliance while maintaining (and improving) the original safety interlocks.

---

## ⚠️ Safety Warning
**This software controls fire.** While this script includes multiple layers of safety logic (Debounce, Pre-Flight Checks, Auto-Shutdown), you are responsible for ensuring your hardware wiring is correct. 
* **NEVER** bypass the factory High-Limit Snap Disc (Overheat Sensor). This must be wired physically in series with the Auger motor.
* **ALWAYS** test the Vacuum and Proof-of-Fire safety stops immediately after installation.

---

## Hardware Configuration

### Wiring Map (Shelly Pro 4PM)

| Channel | Component | Function |
| :--- | :--- | :--- |
| **Output 0** | **Combustion Fan** | Exhaust / Draft (Vents smoke) |
| **Output 1** | **Igniter** | Electric heating element |
| **Output 2** | **Auger Motor** | Fuel feed system |
| **Output 3** | **Convection Fan** | Room blower (Heat distribution) |

| Input | Component | Type |
| :--- | :--- | :--- |
| **Input 0** | **Stop Button** | Momentary Push Button |
| **Input 1** | **Start Button** | Momentary Push Button |
| **Input 2** | **Proof of Fire** | Snap Disc (Low Limit) |
| **Input 3** | **Vacuum Switch** | Pressure safety switch |

### Shelly Settings
1.  **Input Mode:** Set all inputs to **"Button"** mode in the Shelly Web UI.
2.  **Power On Default:** Set Output 0 (Combustion Fan) to **"ON"**. This ensures that if the Shelly reboots unexpectedly, the fan runs to clear smoke.

---

## Software Installation

1.  Open your Shelly Pro 4PM Web Interface IP.
2.  Navigate to **Scripts** -> **Add Script**.
3.  Name it `Winslow-Controller-v12`.
4.  Paste the content of `script.js`.
5.  **Save** and **Start** the script.
6.  Enable **"Run on startup"**.

---

## Virtual Components (Web UI Control)

To control the stove from your phone/browser, you must create these "Virtual Components" in the Shelly interface. The script links to them by ID.

| Type | ID | Name | Function |
| :--- | :--- | :--- | :--- |
| **Boolean** | `200` | **Thermostat** | Toggle ON for High Fire, OFF for Low Fire. |
| **Button** | `200` | **Virtual Start** | Triggers the startup sequence. |
| **Button** | `201` | **Virtual Stop** | Triggers the shutdown/purge sequence. |
| **Button** | `202` | **Force Run** | **Advanced:** Bypasses ignition. Goes straight to "Run" mode. |

---

## Operating Logic (v12.0)

### 1. The "Waterfall" (Crash Prevention)
Unlike standard scripts that fire all commands at once (crashing the Shelly), this controller uses **Serialized Execution**.
* *Example:* When stopping, it turns off the Auger -> waits for confirmation -> turns off Igniter -> waits -> turns on Exhaust.
* This ensures the script never hits the Shelly Gen2 limit of **5 Concurrent RPC Calls**.

### 2. Event-Driven & Debounced
The script does not "poll" (ask) the sensors. It sleeps until a sensor physically changes state.
* **Vacuum Safety:** If the pressure switch opens (vibration/wind), the script waits **10 seconds** ("Forgiveness Time") before shutting down. This prevents false alarms.
* **Fire Safety:** If the fire goes out while running, the script waits **60 seconds** to allow for temporary fuel gaps before shutting down.

### 3. Startup Sequence
1.  **Pre-Flight:** Checks if Vacuum is closed. If Open, aborts immediately.
2.  **Prime (90s):** Fans ON, Igniter ON, Auger feeds pellets to fill the pot.
3.  **Wait (120s):** Auger stops. Igniter stays ON to light the pellets.
4.  **Ramp (420s):** Auger resumes feeding.
5.  **Verification:** At the end of Ramp, checks Proof of Fire.
    * **Hot?** Enters `RUNNING` mode. Igniter OFF.
    * **Cold?** Enters `PURGING` mode (Shutdown).

### 4. Telemetry (Console)
Check the Script Console for a "Heartbeat" message every 30 seconds:
```text
HEARTBEAT: RUNNING (RUN) | Heat: LOW | Vac: OK | Fire: HOT
