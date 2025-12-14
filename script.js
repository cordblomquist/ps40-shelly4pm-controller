// WINSLOW PS40 CONTROLLER - v5.1 (FULL ACTIVE SYNC)
// -------------------------------------------------

// 1. PIN CONFIGURATION
let R_EXHAUST  = 0; // O1: Combustion Fan
let R_IGNITER  = 1; // O2: Ignitor
let R_AUGER    = 2; // O3: Auger
let R_CONV_FAN = 3; // O4: Convection Fan

let I_STOP_BTN  = 0; // S1: Physical Stop Button
let I_START_BTN = 1; // S2: Physical Start Button
let I_POF_SNAP  = 2; // S3: Proof of Fire
let I_VACUUM    = 3; // S4: Vacuum Switch

// VIRTUAL COMPONENT IDs
let VN_HIGH_ON  = 200; // Slider: High Fire ON
let VN_HIGH_OFF = 201; // Slider: High Fire OFF
let VB_FORCE_RUN= 202; // Button: Force Run
let VS_THERMOSTAT= 200; // Boolean: Thermostat Switch

// 2. TIMING PROFILES (Defaults)
let HIGH_ON     = 4500; 
let HIGH_OFF    = 3500;
let LOW_ON      = 3500; 
let LOW_OFF     = 4500; 

let T_PRIME_END = 90 * 1000;      
let T_IGNITE_END= 210 * 1000;     
let T_RUN_START = 7 * 60 * 1000; // UPDATED: 7 Minutes per your request

let SHUTDOWN    = 30 * 60 * 1000; 
let BOOT_PURGE  = 10 * 60 * 1000; 

// STATE VARIABLES
let state = "IDLE"; 
let subState = ""; 
let activeOnTime = 0;
let activeOffTime = 0;
let isHighFire = false; 

// TIMERS
let shutdownTimer = null;
let startupTimer = null;
let safetyTimer = null;
let fireDebounceTimer = null;   
let vacuumDebounceTimer = null; 

print("Winslow Controller: READY v5.1 (Thermostat Sync Fix)");

// 3. LOGIC FUNCTIONS
// ------------------

function updateFeedRate() {
    if (isHighFire) {
        activeOnTime = HIGH_ON;
        activeOffTime = HIGH_OFF;
    } else {
        activeOnTime = LOW_ON;
        activeOffTime = LOW_OFF;
    }
}

function startPurgeMode(time) {
    print("Mode: PURGING / COOLING");
    state = "PURGING";
    subState = "";
    
    Shelly.call("Switch.Set", { id: R_AUGER,    on: false });
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: false });
    Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true }); 
    
    Timer.clear(shutdownTimer);
    Timer.clear(startupTimer);
    Timer.clear(safetyTimer);
    Timer.clear(fireDebounceTimer); 
    Timer.clear(vacuumDebounceTimer);
    
    shutdownTimer = Timer.set(time, false, function() {
        print("Purge Complete. All Systems OFF.");
        Shelly.call("Switch.Set", { id: R_EXHAUST,  on: false });
        Shelly.call("Switch.Set", { id: R_CONV_FAN, on: false }); 
        state = "IDLE";
    });
}

function runAugerCycle() {
    if (subState !== "RAMP" && state !== "RUNNING") {
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });
        return;
    }
    
    Shelly.call("Switch.Set", { id: R_AUGER, on: true });
    
    Timer.set(activeOnTime, false, function() {
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });
        
        if (subState === "RAMP" || state === "RUNNING") {
             Timer.set(activeOffTime, false, function() { runAugerCycle(); });
        }
    });
}

function triggerShutdown(reason) {
    print("SHUTDOWN Triggered: " + reason);
    startPurgeMode(SHUTDOWN);
}

function checkRunTransition() {
    Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(res) {
        if (res && res.state) {
            print("Phase 4: RUN MODE REACHED");
            state = "RUNNING";
            subState = "RUN";
            Shelly.call("Switch.Set", { id: R_IGNITER, on: false });
            updateFeedRate();
        } else {
            triggerShutdown("Startup Failed: No Fire Detected.");
        }
    });
}

function jumpToRunMode() {
    print("FORCE RUN: Entering Run Mode immediately. (Igniter DISABLED)");
    
    Timer.clear(shutdownTimer);
    Timer.clear(startupTimer);
    Timer.clear(safetyTimer); 
    
    state = "RUNNING";
    subState = "RUN";
    
    Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true });
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: false });
    
    Shelly.call("Boolean.GetStatus", { id: VS_THERMOSTAT }, function(res) {
        if (res && typeof res.value !== 'undefined') { isHighFire = res.value; }
        updateFeedRate();
        runAugerCycle();
    });
}

function startColdSequence() {
    print("STARTUP: Beginning Standard Sequence.");
    
    Timer.clear(shutdownTimer);
    Timer.clear(safetyTimer);
    
    state = "STARTUP";
    subState = "PRIME";
    
    Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true });
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: true });
    
    print("Phase 1: PRIME (Feed for 90s)");
    Shelly.call("Switch.Set", { id: R_AUGER, on: true }); 

    startupTimer = Timer.set(T_PRIME_END, false, function() {
        print("Phase 2: WAIT (Igniting...)");
        subState = "WAIT";
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });

        startupTimer = Timer.set(T_IGNITE_END - T_PRIME_END, false, function() {
            print("Phase 3: RAMP UP");
            subState = "RAMP";
            activeOnTime = HIGH_ON; 
            activeOffTime = HIGH_OFF;
            runAugerCycle(); 

            startupTimer = Timer.set(T_RUN_START - T_IGNITE_END, false, function() {
                checkRunTransition();
            });
        });
    });
}

// 4. EVENT HANDLERS
// -----------------
Shelly.addEventHandler(function(event) {
    function isActive(info) { return (info.state === true) || (info.event === "single_push"); }

    if (event.component === "input:" + I_START_BTN) {
        if (isActive(event.info)) startColdSequence();
    }
    if (event.component === "input:" + I_STOP_BTN) {
        if (isActive(event.info)) triggerShutdown("Manual Stop");
    }

    if (event.component === "input:" + I_VACUUM && typeof event.info.state !== 'undefined') {
        if (!event.info.state && (state === "STARTUP" || state === "RUNNING")) {
            if (!vacuumDebounceTimer) {
                print("WARNING: Vacuum Lost. Waiting 10s...");
                vacuumDebounceTimer = Timer.set(10000, false, function() {
                    triggerShutdown("Vacuum Fail (Confirmed)");
                });
            }
        } else if (event.info.state && vacuumDebounceTimer) {
            print("Vacuum Recovered.");
            Timer.clear(vacuumDebounceTimer); vacuumDebounceTimer = null;
        }
    }
    
    if (event.component === "input:" + I_POF_SNAP && typeof event.info.state !== 'undefined') {
        if (!event.info.state && state === "RUNNING") {
            if (!fireDebounceTimer) {
                print("WARNING: Fire Sensor Open. Waiting 60s...");
                fireDebounceTimer = Timer.set(60000, false, function() {
                    triggerShutdown("Fire Out (Confirmed)");
                });
            }
        } else if (event.info.state && state === "RUNNING" && fireDebounceTimer) {
            print("Fire Sensor Recovered.");
            Timer.clear(fireDebounceTimer); fireDebounceTimer = null;
        }
    }

    // Keep Event Handler for "Instant" reaction, but rely on Loop for certainty
    if (event.name === "NotifyStatus" && event.component === "boolean:" + VS_THERMOSTAT) {
        let newVal = event.info.value;
        if (typeof newVal !== 'undefined') {
            isHighFire = newVal;
            updateFeedRate();
        }
    }

    if (event.info.event === "single_push") {
        if (event.component === "button:200") { 
            if (state === "IDLE" || state === "PURGING") startColdSequence(); 
        }
        if (event.component === "button:201") { 
            triggerShutdown("App Stop Command"); 
        }
        if (event.component === "button:" + VB_FORCE_RUN) {
            print(">>> FORCE RUN BUTTON PRESSED");
            jumpToRunMode();
        }
    }
});

// 5. EXECUTION START
// ------------------
startPurgeMode(BOOT_PURGE);

Timer.set(3000, false, function() {
    print("Boot Safety Configured. POWER RESTORED. Running 10min Safety Purge.");
});

// 6. SYNC & STATUS LOOP (Every 10 Seconds)
// ----------------------------------------
Timer.set(10000, true, function() {
    
    // A. SYNC SLIDERS
    Shelly.call("Number.GetStatus", { id: VN_HIGH_ON }, function(res1) {
        if (res1 && res1.value) { HIGH_ON = res1.value * 1000; }
        
        Shelly.call("Number.GetStatus", { id: VN_HIGH_OFF }, function(res2) {
            if (res2 && res2.value) { HIGH_OFF = res2.value * 1000; }
            
            // B. SYNC THERMOSTAT SWITCH (The Fix)
            Shelly.call("Boolean.GetStatus", { id: VS_THERMOSTAT }, function(res3) {
                if (res3 && typeof res3.value !== 'undefined') { 
                    isHighFire = res3.value; 
                }

                // C. UPDATE FEED & PRINT
                updateFeedRate();

                Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(pof) {
                    Shelly.call("Input.GetStatus", { id: I_VACUUM }, function(vac) {
                        
                        let fireStatus = (pof && pof.state) ? "HOT" : "COLD";
                        let vacStatus = (vac && vac.state) ? "OK" : "LOST";
                        let mode = isHighFire ? "HIGH" : "LOW";
                        let onSec = activeOnTime / 1000;
                        let offSec = activeOffTime / 1000;
                        
                        print("--- STATUS: " + state + " (" + subState + ") | Fire: " + fireStatus + " | Vac: " + vacStatus + " | T-Stat: " + mode + " | Feed: " + onSec + "s/" + offSec + "s ---");
                    });
                });
            });
        });
    });
});
