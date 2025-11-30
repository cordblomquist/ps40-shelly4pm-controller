# Winslow PS40 Pellet Stove Controller (Shelly Pro 4PM Retrofit)

## Project Overview
This project replaces the obsolete 20-year-old controller of a Winslow PS40 (also sold as Lennox/Country Stove) with a modern, Wi-Fi-enabled **Shelly Pro 4PM**. 

The goal was to solve "lean burn" issues caused by high draft in a custom vent setup by allowing for fully programmable auger feed rates, while maintaining all original safety features.

## Hardware Required
* **Controller:** Shelly Pro 4PM (DIN-rail smart relay)
* **Enclosure:** 12-Way Surface Mount DIN Rail Box
* **Safety:** The original "Over-Temp" snap switch is hardwired in series with the Auger motor.
* **Inputs:**
    * Shutdown Button (Red, DIN-rail mount)
    * Start Button (Green, DIN-rail mount)
    * Proof of Fire Switch (Original stove sensor)
    * Vacuum Switch (Original stove sensor)

## Wiring Logic
See `wiring_diagram.png` for the visual layout.
* **Auger Safety:** Wired as `Shelly Output O3 -> Over Temp Switch -> Auger Motor`. This ensures a physical hard-cut of fuel if the stove overheats, regardless of software state.
* **Convection Fan:** Wired to Shelly Output O4. The fan runs based on the Shelly logic (Startup/Shutdown modes) AND the physical 120°F snap switch.

## Software Logic (`script.js`)
The Javascript code runs directly on the Shelly Pro 4PM.
* **Startup:** Runs Exhaust and Igniter for 15 mins.
* **Auger Cycle:** Modified to **3.0s ON / 5.0s OFF** (Richer than stock 2.5s/5.5s).
* **Shutdown:** If "Stop" is pressed or Safety Sensors (Vacuum/Proof of Fire) fail, the stove enters a 30-minute cool-down purge.

## Disclaimer
**USE AT YOUR OWN RISK.** This is a custom DIY modification for a combustion appliance. Verify all wiring against your specific stove model. Ensure all safety limits (Over-Temp, Vacuum) are functional before unattended operation.
