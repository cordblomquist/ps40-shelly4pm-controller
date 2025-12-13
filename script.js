// WINSLOW PS40 CONTROLLER - FINAL SAFETY EDITION
// ----------------------------------------------

// 1. PIN CONFIGURATION
let R_EXHAUST  = 0; // O1: Combustion Fan
let R_IGNITER  = 1; // O2: Ignitor
let R_AUGER    = 2; // O3: Auger
let R_CONV_FAN = 3; // O4: Convection Fan

let I_STOP_BTN  = 0; // S1: Physical Stop Button
let I_START_BTN = 1; // S2: Physical Start Button
let I_POF_SNAP  = 2; // S3: Proof of Fire
let I_VACUUM    = 3; // S4: Vacuum Switch

// 2. TIMING PROFILES (milliseconds)
let HIGH_ON     = 4500; 
let HIGH_OFF    = 3500;
let LOW_ON      = 3500; 
let LOW_OFF     = 4500; 

let T_PRIME_END = 90 * 1000;      
let T_IGNITE_END= 210 * 1000;     
let T_RUN_START = 11 * 60 * 1000; 
let T_HOT_BUFFER= 5 * 60 * 1000;  

let SHUTDOWN    = 30 * 60 * 1000; // 30 Minute Purge Duration
let AUTO_PURGE  = 20 * 60 * 1000; 

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

print("Winslow Controller: READY. (Safe Shutdown Logic Verified)");

// 3. LOGIC FUNCTIONS
// ------------------

function updateFeedRate() {
    if (state !== "RUNNING") return;
    if (isHighFire) {
        print(">>> Thermostat Request: HIGH FIRE (4.5s/3.5s)");
        activeOnTime = HIGH_ON;
        activeOffTime = HIGH_OFF;
    } else {
        print(">>> Thermostat Request: LOW FIRE (3.5s/4.5s)");
        activeOnTime = LOW_ON;
        activeOffTime = LOW_OFF;
    }
}

function startPurgeMode(time) {
    print("Mode: PURGING / COOLING");
    state = "PURGING";
    subState = "";
    
    // SAFETY: Kill the fuel and spark
    Shelly.call("Switch.Set", { id: R_AUGER,    on: false });
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: false });
    
    // SAFETY: Force fans ON to clear smoke/heat
    Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true }); 
    
    // Clear operational timers
    Timer.clear(shutdownTimer);
    Timer.clear(startupTimer);
    Timer.clear(safetyTimer);
    
    // Clear debounce timers so we don't trigger double shutdowns
    Timer.clear(fireDebounceTimer); fireDebounceTimer = null;
    Timer.clear(vacuumDebounceTimer); vacuumDebounceTimer = null;
    
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
    // This directs to the Purge function, ensuring fans stay ON.
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
    print("HOT START: Jumping to RUN MODE + 5min Igniter Buffer.");
    state = "RUNNING";
    subState = "RUN";
    
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: true });
    Timer.clear(safetyTimer);
    safetyTimer = Timer.set(T_HOT_BUFFER, false, function() {
        print("Buffer complete: Igniter OFF");
        Shelly.call("Switch.Set", { id: R_IGNITER,  on: false });
    });
    
    Shelly.call("Boolean.GetStatus", { id: 200 }, function(res) {
        if (res && res.value) { isHighFire = true; } 
        else { isHighFire = false; }
        updateFeedRate();
        runAugerCycle();
    });
}

function startColdSequence() {
    print("COLD START: Standard Sequence.");
    Shelly.call("Switch.Set", { id: R_IGNITER,  on: true });
    print("Phase 1: PRIME");
    Shelly.call("Switch.Set", { id: R_AUGER, on: true }); 

    startupTimer = Timer.set(T_PRIME_END, false, function() {
        print("Phase 2: WAIT");
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

function startStartup() {
    print("Mode: STARTUP INITIATED");
    state = "STARTUP";
    subState = "PRIME";
    Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true });
    
    Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(res) {
        if (res && res.state) {
            jumpToRunMode();
        } else {
            startColdSequence();
        }
    });
}

// 4. EVENT HANDLERS
// -----------------
Shelly.addEventHandler(function(event) {
    
    function isActive(info) {
        return (info.state === true) || (info.event === "single_push");
    }

    // 1. PHYSICAL INPUTS
    if (event.component === "input:" + I_START_BTN) {
        if (isActive(event.info)) startStartup();
    }

    if (event.component === "input:" + I_STOP_BTN) {
        if (isActive(event.info)) triggerShutdown("Manual Stop");
    }
    
    // --- VACUUM SAFETY (Debounced) ---
    // If Vacuum signal is lost, wait 10 seconds before Triggering Shutdown.
    if (event.component === "input:" + I_VACUUM && typeof event.info.state !== 'undefined') {
        if (!event.info.state && (state === "STARTUP" || state === "RUNNING")) {
            if (!vacuumDebounceTimer) {
                print("WARNING: Vacuum Lost. Waiting 10s...");
                vacuumDebounceTimer = Timer.set(10000, false, function() {
                    triggerShutdown("Vacuum Fail (Confirmed)");
                });
            }
        } else if (event.info.state) {
            // If vacuum comes back, cancel the kill timer!
            if (vacuumDebounceTimer) {
                print("Vacuum Recovered.");
                Timer.clear(vacuumDebounceTimer);
                vacuumDebounceTimer = null;
            }
        }
    }
    
    // --- FIRE SAFETY (Debounced) ---
    // If Fire Sensor opens while running, wait 60 seconds before Triggering Shutdown.
    if (event.component === "input:" + I_POF_SNAP && typeof event.info.state !== 'undefined') {
        
        // CASE A: Fire Lost while running
        if (!event.info.state && state === "RUNNING") {
            if (!fireDebounceTimer) {
                print("WARNING: Fire Sensor Open. Waiting 60s...");
                fireDebounceTimer = Timer.set(60000, false, function() {
                    triggerShutdown("Fire Out (Confirmed)");
                });
            }
        } 
        // CASE B: Fire Recovered (Sensor closed again)
        else if (event.info.state && state === "RUNNING") {
            if (fireDebounceTimer) {
                print("Fire Sensor Recovered.");
                Timer.clear(fireDebounceTimer);
                fireDebounceTimer = null;
            }
        }
        
        // CASE C: Early Fire Proof during Startup
        if (event.info.state && state === "STARTUP") {
            print("Fire Proven Early!");
            Shelly.call("Switch.Set", { id: R_IGNITER, on: false });
        }
    }

    // 2. VIRTUAL BUTTONS
    if (event.info.event === "single_push") {
        if (event.component === "button:200") {
            if (state === "IDLE" || state === "PURGING") startStartup();
        }
        if (event.component === "button:201") {
             triggerShutdown("App Stop Command (Btn 201)");
        }
    }

    // 3. VIRTUAL SWITCH
    if (event.name === "NotifyStatus" && event.component.indexOf("boolean:") === 0) {
        let newVal = event.info.value;
        if (typeof newVal !== 'undefined') {
            if (newVal) { isHighFire = true; } 
            else { isHighFire = false; }
            updateFeedRate();
        }
    }
});

// 5. EXECUTION START
Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(res) {
    if (res && res.state) {
        print("POWER RESTORED: Hot Stove Detected.");
        Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
        Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true }); 
        jumpToRunMode();
    } else {
        startPurgeMode(AUTO_PURGE);
    }
});
