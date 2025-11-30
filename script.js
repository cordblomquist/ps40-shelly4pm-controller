// WINSLOW PS40 CONTROLLER - FACTORY STARTUP PROFILE
// -------------------------------------------------

// 1. CONFIGURATION (MAPPED TO YOUR WIRING)
// ----------------------------------------
// RELAY OUTPUTS (0-Based Index)
let R_EXHAUST  = 0; // O1: Combustion Blower
let R_IGNITER  = 1; // O2: Ignitor
let R_AUGER    = 2; // O3: Auger
let R_CONV_FAN = 3; // O4: Convection Fan

// INPUTS (0-Based Index)
let I_VACUUM    = 0; // S1: Vacuum Switch
let I_POF_SNAP  = 1; // S2: Proof of Fire
let I_START_BTN = 2; // S3: Green Start Button
let I_STOP_BTN  = 3; // S4: Red Shutdown Button

// TIMING PROFILES (milliseconds)
// Phase 3: "Ramp Up" (Aggressive factory setting)
let RAMP_ON     = 4000; 
let RAMP_OFF    = 4000;

// Phase 4: "Run Mode" (Your Custom Rich Setting)
let RUN_ON      = 3000; 
let RUN_OFF     = 5000; 

// Startup Benchmarks (Time from Button Press)
let T_PRIME_END = 90 * 1000;      // 1m 30s
let T_IGNITE_END= 210 * 1000;     // 3m 30s
let T_RUN_START = 11 * 60 * 1000; // 11m 00s

let SHUTDOWN    = 30 * 60 * 1000; // 30 mins cool down
let AUTO_PURGE  = 20 * 60 * 1000; // 20 mins purge on power connect

// STATE VARIABLES
let state = "IDLE"; 
let subState = ""; // Tracks the 4 startup phases
let activeOnTime = 0;
let activeOffTime = 0;
let shutdownTimer = null;
let startupTimer = null; // Main startup sequence tracker

print("Winslow Controller: Factory Profile Loaded");

// 2. POWER ON SEQUENCE
startPurgeMode(AUTO_PURGE);

// 3. LOGIC FUNCTIONS
// ------------------

function startPurgeMode(time) {
    print("Mode: PURGING / COOLING");
    state = "PURGING";
    subState = "";
    
    // Safety: Kill Fire & Fuel
    Shelly.call("Switch.Set", { id: R_AUGER,    on: false });
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: false });

    // Action: Run Fans
    Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true }); 
    
    Timer.clear(shutdownTimer);
    Timer.clear(startupTimer);
    
    shutdownTimer = Timer.set(time, false, function() {
        print("Purge Complete. IDLE.");
        Shelly.call("Switch.Set", { id: R_EXHAUST,  on: false });
        Shelly.call("Switch.Set", { id: R_CONV_FAN, on: false }); 
        state = "IDLE";
    });
}

function startStartup() {
    print("Mode: STARTUP INITIATED");
    state = "STARTUP";
    subState = "PRIME";
    
    // 1. Global Components ON
    Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true });
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: true });
    
    // -----------------------------------------------------
    // PHASE 1: PRIME (0:00 to 1:30) - Constant Feed
    // -----------------------------------------------------
    print("Phase 1: PRIME (Filling Pot)");
    Shelly.call("Switch.Set", { id: R_AUGER, on: true }); // Auger Continuous

    // Schedule Phase 2
    startupTimer = Timer.set(T_PRIME_END, false, function() {
        // -------------------------------------------------
        // PHASE 2: IGNITION WAIT (1:30 to 3:30) - No Feed
        // -------------------------------------------------
        print("Phase 2: IGNITE WAIT (Auger Off)");
        subState = "WAIT";
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });

        // Schedule Phase 3
        startupTimer = Timer.set(T_IGNITE_END - T_PRIME_END, false, function() {
            // ---------------------------------------------
            // PHASE 3: RAMP UP (3:30 to 11:00) - 4s/4s Cycle
            // ---------------------------------------------
            print("Phase 3: RAMP UP (4s ON / 4s OFF)");
            subState = "RAMP";
            activeOnTime = RAMP_ON;
            activeOffTime = RAMP_OFF;
            runAugerCycle(); // Start the loop

            // Schedule Phase 4
            startupTimer = Timer.set(T_RUN_START - T_IGNITE_END, false, function() {
                // -----------------------------------------
                // PHASE 4: RUN MODE (11:00+) - 3s/5s Cycle
                // -----------------------------------------
                // Only switch to Run if Fire is Proven (Safety)
                // We check POF status by "peeking" via logic, 
                // but usually the Event Handler handles this.
                // Here we force the transition if safety passes.
                
                checkRunTransition();
            });
        });
    });
}

function checkRunTransition() {
    // We hit the 11-minute mark.
    // If POF input is closed, we enter RUN.
    // If POF is open, we shutdown.
    
    Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(res) {
        if (res && res.state) {
            print("Phase 4: RUN MODE REACHED (Igniter Off)");
            state = "RUNNING";
            subState = "RUN";
            
            // Turn off Igniter
            Shelly.call("Switch.Set", { id: R_IGNITER, on: false });
            
            // Switch to User Custom Timing (Rich Mix)
            activeOnTime = RUN_ON;
            activeOffTime = RUN_OFF;
        } else {
            triggerShutdown("Startup Failed: 11 mins passed, no fire detected.");
        }
    });
}

function runAugerCycle() {
    // Logic: Only run loop if we are in RAMP or RUNNING phases
    if (subState !== "RAMP" && state !== "RUNNING") {
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });
        return;
    }

    Shelly.call("Switch.Set", { id: R_AUGER, on: true });
    
    Timer.set(activeOnTime, false, function() {
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });
        
        if (subState === "RAMP" || state === "RUNNING") {
             Timer.set(activeOffTime, false, function() {
                 runAugerCycle();
             });
        }
    });
}

function triggerShutdown(reason) {
    print("SHUTDOWN Triggered: " + reason);
    startPurgeMode(SHUTDOWN);
}

// 4. INPUT HANDLERS
// -----------------
Shelly.addEventHandler(function(event) {
    if (typeof event.info.state === 'undefined') return;
    
    let id = event.info.id;
    let active = event.info.state; 

    // S3: START BUTTON (Green)
    if (id === I_START_BTN && active) {
        if (state === "IDLE" || state === "PURGING") {
            startStartup();
        }
    }

    // S4: STOP BUTTON (Red)
    if (id === I_STOP_BTN && active) {
        triggerShutdown("Manual Stop");
    }

    // S1: VACUUM (Safety)
    if (id === I_VACUUM) {
        if (!active && (state === "STARTUP" || state === "RUNNING")) {
            triggerShutdown("Vacuum Fail");
        }
    }
    
    // S2: POF (Loss of fire while running)
    if (id === I_POF_SNAP) {
        if (state === "RUNNING" && !active) {
            triggerShutdown("Fire Out");
        }
        // Note: We don't auto-switch to RUN on POF close anymore.
        // We wait for the 11-min timer to finish Phase 3 to ensure full coal bed.
    }
});
