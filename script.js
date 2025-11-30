// WINSLOW PS40 CONTROLLER - UPDATED PIN MAPPING
// ---------------------------------------------

// 1. CONFIGURATION (MAPPED TO YOUR WIRING)
// ----------------------------------------

// RELAY OUTPUTS (O1-O4)
// Shelly uses 0-based indexing: O1=0, O2=1, O3=2, O4=3
let R_EXHAUST  = 0; // O1: Combustion Blower
let R_IGNITER  = 1; // O2: Ignitor
let R_AUGER    = 2; // O3: Auger (Series w/ Over-Temp)
let R_CONV_FAN = 3; // O4: Convection Fan

// SENSOR INPUTS (S1-S4)
// Shelly uses 0-based indexing: S1=0, S2=1, S3=2, S4=3
let I_VACUUM    = 0; // S1: Vacuum Switch
let I_POF_SNAP  = 1; // S2: Proof of Fire
let I_START_BTN = 2; // S3: Green Start Button
let I_STOP_BTN  = 3; // S4: Red Shutdown Button

// TIMING SETTINGS (milliseconds)
let AUGER_ON    = 3000;  // 3.0 Seconds ON
let AUGER_OFF   = 5000;  // 5.0 Seconds OFF
let IGNITER_MAX = 10 * 60 * 1000; // 10 mins max for igniter
let STARTUP_MAX = 15 * 60 * 1000; // 15 mins to prove fire
let SHUTDOWN    = 30 * 60 * 1000; // 30 mins cool down purge
let AUTO_PURGE  = 20 * 60 * 1000; // 20 mins purge on power connect

// STATE VARIABLES
let state = "IDLE"; 
let augerTimer = null;
let shutdownTimer = null;

print("Stove Controller Started with Updated Pin Map");

// 2. POWER ON SEQUENCE
// --------------------
// Immediately run exhaust to purge any smoke/fumes
startPurgeMode(AUTO_PURGE);

// 3. LOGIC FUNCTIONS
// ------------------

function startPurgeMode(time) {
    print("Mode: PURGING / COOLING for " + (time/60000) + " mins");
    state = "PURGING";
    
    // Safety: Kill Fire & Fuel
    Shelly.call("Switch.Set", { id: R_AUGER,    on: false });
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: false });

    // Action: Run Fans
    Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true }); 
    
    // Clear any pending shutdown timers
    if(shutdownTimer) Timer.clear(shutdownTimer);
    
    shutdownTimer = Timer.set(time, false, function() {
        print("Purge Complete. Entering IDLE.");
        Shelly.call("Switch.Set", { id: R_EXHAUST,  on: false });
        Shelly.call("Switch.Set", { id: R_CONV_FAN, on: false }); 
        state = "IDLE";
    });
}

function startStartup() {
    print("Mode: STARTUP INITIATED");
    state = "STARTUP";
    
    // Components ON
    Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true });
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: true });
    
    // Start Feeding Pellets
    runAugerCycle(); 

    // Safety Timer 1: Turn off Igniter after 10 mins (save element life)
    Timer.set(IGNITER_MAX, false, function() {
        print("Startup: Igniter Timeout (OFF)");
        Shelly.call("Switch.Set", { id: R_IGNITER, on: false });
    });

    // Safety Timer 2: Check if Fire started after 15 mins
    Timer.set(STARTUP_MAX, false, function() {
        // If we are still in STARTUP mode, it means POF never closed.
        if (state === "STARTUP") {
            triggerShutdown("Startup Failed - No Fire Detected");
        }
    });
}

function runAugerCycle() {
    // Only run if we are in an active Fire mode
    if (state !== "STARTUP" && state !== "RUNNING") {
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });
        return;
    }

    // Auger ON
    Shelly.call("Switch.Set", { id: R_AUGER, on: true });
    
    // Wait 3 seconds...
    Timer.set(AUGER_ON, false, function() {
        // Auger OFF
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });
        
        // Wait 5 seconds, then Loop...
        if (state === "STARTUP" || state === "RUNNING") {
             Timer.set(AUGER_OFF, false, function() {
                 runAugerCycle();
             });
        }
    });
}

function triggerShutdown(reason) {
    print("SHUTDOWN Triggered: " + reason);
    startPurgeMode(SHUTDOWN);
}

// 4. INPUT HANDLER (THE BRAINS)
// -----------------------------
Shelly.addEventHandler(function(event) {
    if (typeof event.info.state === 'undefined') return;
    
    let id = event.info.id;
    let active = event.info.state; // true = Closed (ON), false = Open (OFF)

    // S3: GREEN START BUTTON (ID 2)
    if (id === I_START_BTN && active) {
        if (state === "IDLE" || state === "PURGING") {
            startStartup();
        }
    }

    // S4: RED SHUTDOWN BUTTON (ID 3)
    if (id === I_STOP_BTN && active) {
        triggerShutdown("Manual Stop Button Pressed");
    }

    // S2: PROOF OF FIRE (ID 1)
    if (id === I_POF_SNAP) {
        if (state === "STARTUP" && active) {
            print("Event: Fire Detected! Switching to RUN Mode.");
            state = "RUNNING";
            Shelly.call("Switch.Set", { id: R_IGNITER, on: false }); // Save Igniter
        }
        else if (state === "RUNNING" && !active) {
            triggerShutdown("Fire Went Out (POF Open)");
        }
    }

    // S1: VACUUM SWITCH (ID 0)
    if (id === I_VACUUM) {
        // If Vacuum opens while running, shut down
        if (!active && (state === "STARTUP" || state === "RUNNING")) {
            triggerShutdown("Vacuum Safety Switch Opened");
        }
    }
});