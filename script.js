// WINSLOW PS40 CONTROLLER - v11.0 (Event-Driven + Debounce)
// ---------------------------------------------------------
// FINAL ARCHITECTURE:
// 1. OPERATION: Event-Driven (No Loops/Polling) -> Prevents Crashes.
// 2. SAFETY:    Timer-Based Debounce -> Prevents False Positives.
// 3. AUGER:     Precision Pulse -> Controlled High/Low Fire.

// PIN MAPPING
let R_EXHAUST  = 0; 
let R_IGNITER  = 1; 
let R_AUGER    = 2; 
let R_CONV_FAN = 3; 

// INPUTS
let I_STOP_BTN  = 0; 
let I_START_BTN = 1; 
let I_POF_SNAP  = 2; // Proof of Fire
let I_VACUUM    = 3; // Vacuum

// VIRTUAL COMPONENTS
let V_BTN_START = 200; 
let V_BTN_STOP  = 201; 
let V_BTN_FORCE = 202; 
let VS_THERMOSTAT = 200; 

// CONFIGURATION (Seconds)
let T_PRIME  = 90;
let T_IGNITE = 120;
let T_RAMP   = 420;
let T_PURGE  = 1800; // 30 min cooldown

// DEBOUNCE THRESHOLDS (The "Forgiveness" Time)
let DB_VACUUM = 10 * 1000; // 10 seconds
let DB_FIRE   = 60 * 1000; // 60 seconds

// FEED VARIABLES
let activeOn  = 3000;  
let activeOff = 5000; 

// STATE
let state = "IDLE";
let subState = "";
let isHighFire = false;

// TIMERS
let augerTimer = null;
let phaseTimer = null;
let vacDebounceTimer = null;  // NEW: "Doom Timer" for Vacuum
let fireDebounceTimer = null; // NEW: "Doom Timer" for Fire

// TELEMETRY CACHE
let lastVac = "OK";    
let lastFire = "COLD"; 

print("WINSLOW CONTROLLER v11.0: DEBOUNCE ENABLED");

// 1. FEED LOGIC
// -------------

function updateFeedParams() {
    if (isHighFire) {
        activeOn  = 4500; 
        activeOff = 3500;
    } else {
        activeOn  = 3000;
        activeOff = 5000;
    }
}

function runAugerCycle() {
    if (state !== "RUNNING" && subState !== "PRIME" && subState !== "RAMP") {
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });
        return; 
    }

    Shelly.call("Switch.Set", { id: R_AUGER, on: true });

    augerTimer = Timer.set(activeOn, false, function() {
        Shelly.call("Switch.Set", { id: R_AUGER, on: false });

        if (state === "RUNNING" || subState === "PRIME" || subState === "RAMP") {
            augerTimer = Timer.set(activeOff, false, function() {
                runAugerCycle(); 
            });
        }
    });
}

// 2. CORE COMMANDS
// ----------------

function stopStove(purgeDuration) {
    print("!!! STOPPING STOVE !!!");
    state = "PURGING"; 
    subState = "COOLING";
    
    // KILL ALL TIMERS IMMEDIATELY
    Timer.clear(augerTimer);
    Timer.clear(phaseTimer);
    Timer.clear(vacDebounceTimer);  // Stop checking vacuum
    Timer.clear(fireDebounceTimer); // Stop checking fire
    
    Shelly.call("Switch.Set", { id: R_AUGER,   on: false });
    Shelly.call("Switch.Set", { id: R_IGNITER, on: false });
    Shelly.call("Switch.Set", { id: R_EXHAUST, on: true });
    Shelly.call("Switch.Set", { id: R_CONV_FAN,on: true });
    
    phaseTimer = Timer.set(purgeDuration * 1000, false, function() {
        print("Purge Complete. System IDLE.");
        state = "IDLE";
        subState = "";
        Shelly.call("Switch.Set", { id: R_EXHAUST, on: false });
        Shelly.call("Switch.Set", { id: R_CONV_FAN, on: false });
    });
}

function startStartup() {
    if (state !== "IDLE" && state !== "PURGING") return;
    print("CMD: Start Received. Checking Sensors...");
    
    // PRE-FLIGHT: We check instant status here. 
    // If it's ALREADY open, we don't debounce, we just refuse to start.
    Shelly.call("Input.GetStatus", { id: I_VACUUM }, function(res) {
        if (res && !res.state) {
            print("FAILURE: Vacuum is OPEN. Cannot Start.");
            lastVac = "OPEN";
            return; 
        }
        
        print("SENSORS OK. IGNITION SEQUENCE STARTED.");
        state = "STARTUP";
        subState = "PRIME";
        lastVac = "OK";
        
        Shelly.call("Switch.Set", { id: R_EXHAUST,  on: true });
        Shelly.call("Switch.Set", { id: R_CONV_FAN, on: true });
        Shelly.call("Switch.Set", { id: R_IGNITER,  on: true });
        
        updateFeedParams();
        runAugerCycle();
        
        // TIMING CHAIN
        phaseTimer = Timer.set(T_PRIME * 1000, false, function() {
            print(">>> PHASE: WAIT (No Feed)");
            subState = "WAIT";
            Shelly.call("Switch.Set", { id: R_AUGER, on: false });
            Timer.clear(augerTimer); 
            
            phaseTimer = Timer.set(T_IGNITE * 1000, false, function() {
                print(">>> PHASE: RAMP (Feed Resumed)");
                subState = "RAMP";
                runAugerCycle(); 
                
                phaseTimer = Timer.set(T_RAMP * 1000, false, function() {
                    // END OF RAMP - FINAL FIRE CHECK
                    Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(res) {
                        if (res && res.state) {
                            print("SUCCESS: Fire Detected. RUNNING.");
                            state = "RUNNING";
                            subState = "RUN";
                            lastFire = "HOT";
                            Shelly.call("Switch.Set", { id: R_IGNITER, on: false });
                        } else {
                            print("FAILURE: No Fire. Shutting Down.");
                            lastFire = "COLD";
                            stopStove(T_PURGE);
                        }
                    });
                });
            });
        });
    });
}

// 3. STATUS HANDLER (DEBOUNCED SAFETY)
// ------------------------------------
Shelly.addStatusHandler(function(status) {
    
    // --- VACUUM LOGIC ---
    if (status.component === "input:" + I_VACUUM) {
        
        // Case 1: Vacuum LOST (Switch Opens)
        if (status.delta.state === false) { 
            print("ALERT: Vacuum Signal Lost! Starting 10s Debounce...");
            lastVac = "UNSTABLE";
            
            // Start the "Doom Timer"
            // If this timer finishes, we shut down.
            vacDebounceTimer = Timer.set(DB_VACUUM, false, function() {
                print("SAFETY TRIP: Vacuum lost for > 10s. SHUTDOWN.");
                lastVac = "OPEN";
                stopStove(T_PURGE);
            });
        
        // Case 2: Vacuum RECOVERED (Switch Closes)
        } else if (status.delta.state === true) {
            // Cancel the Doom Timer immediately
            if (vacDebounceTimer) {
                print("INFO: Vacuum Signal Recovered.");
                Timer.clear(vacDebounceTimer);
                vacDebounceTimer = null;
            }
            lastVac = "OK";
        }
    }

    // --- PROOF OF FIRE LOGIC ---
    if (status.component === "input:" + I_POF_SNAP) {
        
        // Case 1: Fire LOST (Switch Opens) - Only matters in RUN mode
        if (state === "RUNNING" && status.delta.state === false) {
             print("ALERT: Fire Signal Lost! Starting 60s Debounce...");
             lastFire = "UNSTABLE";
             
             fireDebounceTimer = Timer.set(DB_FIRE, false, function() {
                 print("SAFETY TRIP: Fire lost for > 60s. SHUTDOWN.");
                 lastFire = "COLD";
                 stopStove(T_PURGE);
             });
        }
        
        // Case 2: Fire RECOVERED
        else if (state === "RUNNING" && status.delta.state === true) {
             if (fireDebounceTimer) {
                 print("INFO: Fire Signal Recovered.");
                 Timer.clear(fireDebounceTimer);
                 fireDebounceTimer = null;
             }
             lastFire = "HOT";
        }

        // Case 3: Early Ignition (Startup Shortcut)
        else if (state === "STARTUP" && subState === "RAMP" && status.delta.state === true) {
             print("SUCCESS: Fire Detected Early!");
             state = "RUNNING";
             subState = "RUN";
             lastFire = "HOT";
             Shelly.call("Switch.Set", { id: R_IGNITER, on: false });
             Timer.clear(phaseTimer); // Cancel startup timeout
        }
    }
    
    // --- THERMOSTAT ---
    if (status.component === "boolean:" + VS_THERMOSTAT) {
        isHighFire = status.delta.value;
        updateFeedParams();
        print("SETTINGS: Heat changed to " + (isHighFire ? "HIGH" : "LOW"));
    }
});

// 4. EVENT HANDLER (BUTTONS)
// --------------------------
Shelly.addEventHandler(function(event) {
    let isPush = (event.info.event === "single_push" || event.info.event === "btn_down");
    let c = event.component;
    if (!isPush) return;

    if (c === "input:" + I_START_BTN) startStartup();
    if (c === "input:" + I_STOP_BTN)  stopStove(T_PURGE);
    if (c === "button:" + V_BTN_START) startStartup();
    if (c === "button:" + V_BTN_STOP)  stopStove(T_PURGE);
    
    if (c === "button:" + V_BTN_FORCE) {
        print("CMD: Force Run");
        state = "RUNNING";
        subState = "RUN";
        Shelly.call("Switch.Set", { id: R_IGNITER, on: false });
        Shelly.call("Switch.Set", { id: R_EXHAUST, on: true });
        Shelly.call("Switch.Set", { id: R_CONV_FAN,on: true });
        runAugerCycle();
    }
});

// 5. HEARTBEAT
// ------------
Timer.set(30000, true, function() {
    let mode = isHighFire ? "HIGH" : "LOW";
    print("HEARTBEAT: " + state + " (" + subState + ") | Heat: " + mode + 
          " | Vac: " + lastVac + " | Fire: " + lastFire);
});

// 6. BOOT
stopStove(600);
