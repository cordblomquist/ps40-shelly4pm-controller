# Winslow PS40 Pellet Stove Controller (Shelly Pro 4PM)

## 1. Project Overview

**Objective:** Replace a failing or obsolete factory control board for a Winslow PS40 pellet stove with a modern, Wi-Fi-enabled industrial controller.

**Core Hardware:** Shelly Pro 4PM (4-channel smart relay with DIN rail mounting).

**Software Environment:** Shelly `mJS` (Micro-JavaScript) scripting engine.

**Control Logic:** The stove operates on a "Combustion Loop" where the auger feeds fuel on a timed cycle (ON/OFF) based on heat demand, while safety sensors (Vacuum and Proof of Fire) monitor the stove's physical state to prevent hazards.

---

## 2. Hardware Configuration

### Wiring & Output Map (Relays)

* **Switch 0 (O1): Combustion Fan (Exhaust)**
  * **Function:** Pulls air through the burn pot and vents smoke outside.
  * **Safety Default:** Must be configured in Shelly settings as **"Power On Default: ON"**. This ensures the fan runs immediately if the device reboots or crashes, preventing smoke buildup.

* **Switch 1 (O2): Igniter**
  * **Function:** Superheats air to light the pellets during the startup phase.
  * **Logic:** Runs for the first few minutes of startup, then shuts off.

* **Switch 2 (O3): Auger Motor (Fuel Feed)**
  * **Function:** Feeds pellets into the burn pot.
  * **Logic:** Cycles ON and OFF (e.g., 3s ON, 5s OFF).

> [!WARNING]
> **HARDWARE SAFETY INTERLOCK (INVISIBLE TO SOFTWARE)**
> There is a **High-Temperature Limit Switch** (Snap Disc) wired physically **in-line (series)** with the Auger Motor.
> * **Function:** If the hopper or feed tube exceeds safety limits (e.g., 200°F), this switch physically cuts power to the motor.
> * **Note:** The software cannot "see" this switch. The Shelly Dashboard may show the Auger as "ON," but if this safety switch is tripped, the motor will not turn. This is a redundant, fail-safe layer that overrides the software.
>

* **Switch 3 (O4): Convection Fan (Room Blower)**
  * **Function:** Blows warm air into the room.
  * **Logic:** Turned ON by the script during the run cycle.

> [!NOTE]
> **HARDWARE THERMAL INTERLOCK**
> There is a **Convection Snap Disc** (Temperature Switch) wired physically **in-line (series)** with the Convection Fan.
> * **Function:** This switch only closes when the stove body is hot (e.g., >110°F).
> * **Note:** This prevents the fan from blowing cold air during the first few minutes of startup. The Shelly script may turn the Relay "ON" immediately, but the fan will not actually spin until the stove warms up and this analog switch closes.
>

### Input Configuration (Sensors & Switches)> [!IMPORTANT]

**Crucial Setting:** All inputs must be set to **"Detached"** mode in the Shelly App. This separates the physical switch from the relay, allowing the script to decide how to react to the signal.

* **Input 0 (S1): Stop Button**
  * *Type:* Momentary Button.
  * *Function:* Triggers the shutdown/purge sequence.


* **Input 1 (S2): Start Button**
  * *Type:* Momentary Button.
  * *Function:* Initiates the Cold Start sequence.


* **Input 2 (S3): Proof of Fire (POF) Snap Disc**
  * *Type:* Switch (Toggle).
  * *Function:* Thermal switch on the exhaust housing. Closes when the stove is hot. Used to verify fire is present.


* **Input 3 (S4): Vacuum Switch**
  * *Type:* Switch (Toggle).
  * *Function:* Safety pressure switch. Opens if the door is ajar or the exhaust is blocked. Instantly cuts auger power via script logic if lost.

---

## 3. Operational Logic & Modes

The controller is a **Finite State Machine (FSM)**. This means the stove is always in one of four distinct "Modes" (Idle, Startup, Running, Purging). The script determines which components to run based on the current mode.

### A. The Startup Sequence (Mode: `STARTUP`)

Because pellet fuel requires very high heat to ignite, the stove cannot simply turn "On." It must execute a precise timing sequence to establish a flame safely.

1. **Phase 1: Prime (0s – 90s)**
  * **Action:** Exhaust Fan ON, Igniter ON, Auger ON (Continuous).
  * **Goal:** Fill the burn pot with a base layer of fresh pellets.


2. **Phase 2: Wait/Ignite (90s – 210s)**
  * **Action:** Auger Stops. Igniter stays ON. Fans stay ON.
  * **Goal:** The igniter superheats the air blowing onto the pellets. The "Wait" ensures we don't smother the spark with too much fuel.


3. **Phase 3: Ramp Up (3.5min – 11min)**
  * **Action:** Auger resumes pulsing (High Fire rate). Igniter stays ON.
  * **Goal:** Feed fresh fuel to the small flame to grow it into a stable fire.


4. **Phase 4: Transition Check**
  * **Action:** The script checks the **Proof of Fire (POF)** sensor.
  * **Success:** If HOT, transition to `RUNNING`. Igniter turns OFF.
  * **Failure:** If COLD, trigger Safety Shutdown (No Fire Detected).



### B. Run Mode (Mode: `RUNNING`)

Once the fire is established, the stove enters its main loop. The Auger Motor uses **Duty Cycle Modulation** to control the fire size.

* **Pulse Principle:** The auger is a single-speed motor. We control fuel amount by varying how long it runs versus how long it pauses.
  * **High Fire (Heating):** Triggered when Virtual Thermostat (Boolean 200) is **ON**. Uses the "Virtual Slider" values (e.g., 4.5s ON / 3.5s OFF).
  * **Low Fire (Pilot):** Triggered when Virtual Thermostat is **OFF**. Uses hardcoded safety values (3.5s ON / 4.5s OFF) to keep the fire alive without overheating the room.



### C. Shutdown & Purge (Mode: `PURGING`)'

This mode is triggered manually (Stop Button) or automatically (Safety Failure).

* **Action:** Auger OFF (immediately). Igniter OFF. Exhaust & Convection Fans **ON**.
* **Duration:** 30 Minutes.
* **Goal:** Burn up any remaining pellets in the pot and vent all smoke. The long duration ensures the stove is cool to the touch before the fans stop.

### D. Idle (Mode: `IDLE`)
* **Action:** All Relays OFF.
* **Logic:** The script waits for the **Start Button** (Physical or Virtual).

---

## 4. Virtual Component Dictionary

These are software-defined controls created inside the Shelly "Components" interface. They do not exist physically but appear on the App Dashboard.

### A. Virtual Switch (Boolean)
* **ID:** `boolean:200`
* **Name:** `Thermostat` (or "Heat Demand")
* **Function:** This is the input for your home heating needs.
  * *Usage:* You can toggle this manually in the app, or automate it using a Shelly H&T (Humidity & Temp) sensor scene.
  * *Logic:* `ON` = High Fire. `OFF` = Low Fire.



### B. Virtual Numbers (Sliders)
* **ID:** `number:200`
  * **Name:** `High Fire ON`
  * **Range:** 1.0 – 10.0 (Seconds)
  * **Function:** Controls how long the auger spins during High Fire.


* **ID:** `number:201`
  * **Name:** `High Fire OFF`
  * **Range:** 1.0 – 10.0 (Seconds)
  * **Function:** Controls the pause between feeds.



### C. Virtual Buttons (Triggers)

These are momentary "soft keys" used to send commands to the script.

* **ID:** `button:200`
  * **Name:** `Virtual Start`
  * **Function:** Starts the "Cold Sequence" (Prime -> Ignite -> Run).


* **ID:** `button:201`
  * **Name:** `Virtual Stop`
  * **Function:** Triggers the Safety Shutdown (Purge).


* **ID:** `button:202`
  * **Name:** `Force Run`
  * **Function:** Bypasses the 15-minute startup sequence. Instantly turns on fans and auger without running the igniter.

---

## 5. The "Brain": Script Version 5.0

**Key Features:**

* **Fail-Safe Boot:** On power-up, the script immediately forces fans ON and enters a 10-minute safety purge to clear smoke.
* **Active Polling:** The script actively checks Virtual Slider values every 10 seconds to update feed rates instantly without requiring a reboot.
* **Debounce Logic:** Electronic noise filtering prevents the stove from shutting down due to split-second sensor flickers.
* **Crash Protection:** The code includes logic to clear "Ghost Timers" (timers from a previous state that persisted through a reboot or state change), ensuring the stove never unexpectedly shuts down in the middle of a burn.

---

## 6. Quality Assurance (QA) Testing Protocol*Run these tests before using the stove for the season.*

| Test | Action | Expected Result |
| --- | --- | --- |
| **Input Check** | Manually toggle Vac/Fire sensors. Press Stop. | Console prints status updates. No relays click instantly (unless Stop is pressed). |
| **Startup Seq** | Press Start Button. | Fans ON, Igniter ON, Auger ON (Prime). Script enters `STARTUP` mode. |
| **Thermostat** | Toggle Virtual Switch 200. | Feed rate changes in the "Heartbeat" log (e.g., from 3.5s to 4.5s). |
| **Vacuum Safe** | Disconnect Vac wire (simulate door open). | Console warns. Wait 10s -> Shutdown Triggered. Exhaust fan stays ON. |
| **Fire Safe** | Disconnect Fire wire (simulate flame out). | Console warns. Wait 60s -> Shutdown Triggered. |
| **Power Fail** | Unplug stove, plug back in. | **Combustion fan starts IMMEDIATELY.** Console: `POWER RESTORED`. |
| **Force Run** | Press Button 202. | Script jumps to `RUNNING`. Igniter stays **OFF**. Fans ON. |
