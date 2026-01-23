// WINSLOW PS40 CONTROLLER - v12.2 (Stable / Event-Driven)
// -------------------------------------------------------
// ARCHITECTURE: Waterfall RPC (Serialized Calls)
// FIX v12.1: Clears boot/purge timers when Start is pressed to prevent 
//            shutdown 10 mins into the run.

// PIN MAPPING
let R_EXHAUST  = 0; 
let R_IGNITER  = 1; 
let R_AUGER    = 2; 
let R_CONV_FAN = 3; 

let I_STOP_BTN  = 0; 
let I_START_BTN = 1; 
let I_POF_SNAP  = 2; 
let I_VACUUM    = 3; 

// VIRTUAL COMPONENTS
let V_BTN_START = 200; 
let V_BTN_STOP  = 201; 
let V_BTN_FORCE = 202; 
let VS_THERMOSTAT = 200; 

// CONFIGURATION (Seconds)
let T_PRIME  = 90;
let T_IGNITE = 120;
let T_RAMP   = 420;
let T_PURGE  = 1800; 

// DEBOUNCE THRESHOLDS
let DB_VACUUM = 10 * 1000; 
let DB_FIRE   = 60 * 1000; 

// STATE
let state = "IDLE";
let subState = "";
let isHighFire = false;
let activeOn  = 3000;   
let activeOff = 5000; 

// TIMERS
let augerTimer = null;
let phaseTimer = null;
let vacDebounceTimer = null;   
let fireDebounceTimer = null; 

// TELEMETRY CACHE
let lastVac = "WAIT";    
let lastFire = "WAIT"; 

print("WINSLOW CONTROLLER v12.1: SERIALIZED RPC");

// 1. HELPER: The "Safe Switch" (Prevents RPC flooding)
// ----------------------------------------------------
function setRelay(id, state, callback) {
    Shelly.call("Switch.Set", { id: id, on: state }, function() {
        if (callback) callback();
    });
}

// 2. FEED LOGIC
// -------------
function updateFeedParams() {
    activeOn  = isHighFire ? 4500 : 3000; 
    activeOff = isHighFire ? 3500 : 5000;
}

function runAugerCycle() {
    if (state !== "RUNNING" && subState !== "PRIME" && subState !== "RAMP") {
        setRelay(R_AUGER, false);
        return; 
    }

    // ON
    setRelay(R_AUGER, true, function() {
        // Wait for ON time
        augerTimer = Timer.set(activeOn, false, function() {
            // OFF
            setRelay(R_AUGER, false, function() {
                // Wait for OFF time
                if (state === "RUNNING" || subState === "PRIME" || subState === "RAMP") {
                    augerTimer = Timer.set(activeOff, false, function() {
                        runAugerCycle(); 
                    });
                }
            });
        });
    });
}

// 3. SAFE SHUTDOWN (The Waterfall)
// --------------------------------
// Forces relays 1-by-1 to avoid "Too Many Calls"
function stopStove(purgeDuration) {
    print("!!! STOPPING STOVE !!!");
    state = "PURGING"; 
    subState = "COOLING";
    
    // Kill timers
    Timer.clear(augerTimer);
    Timer.clear(phaseTimer);
    Timer.clear(vacDebounceTimer); 
    Timer.clear(fireDebounceTimer);
    
    // WATERFALL SEQUENCE: Auger -> Igniter -> Exhaust -> Fan
    setRelay(R_AUGER, false, function() {
        setRelay(R_IGNITER, false, function() {
            setRelay(R_EXHAUST, true, function() {
                setRelay(R_CONV_FAN, true, function() {
                    
                    // Set Purge Timer
                    phaseTimer = Timer.set(purgeDuration * 1000, false, function() {
                        print("Purge Complete. Fans OFF.");
                        state = "IDLE";
                        subState = "";
                        setRelay(R_EXHAUST, false, function() {
                            setRelay(R_CONV_FAN, false);
                        });
                    });
                });
            });
        });
    });
}

// 4. SYNC SENSORS (The Waterfall)
// -------------------------------
function syncSensors() {
    // 1. Check Fire
    Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(res) {
        if (res) lastFire = res.state ? "HOT" : "COLD";
        
        // 2. Check Vacuum (Only after Fire checks out)
        Shelly.call("Input.GetStatus", { id: I_VACUUM }, function(vac) {
             if (vac) lastVac = vac.state ? "OK" : "OPEN";
             
             // 3. Check Thermostat (Only after Vacuum checks out)
             Shelly.call("Boolean.GetStatus", { id: VS_THERMOSTAT }, function(therm) {
                 if (therm && typeof therm.value !== 'undefined') {
                     isHighFire = therm.value;
                     updateFeedParams();
                 }
                 
                 // DONE: Print Status
                 let mode = isHighFire ? "HIGH" : "LOW";
                 print("HEARTBEAT: " + state + " (" + subState + ") | Heat: " + mode + 
                       " | Vac: " + lastVac + " | Fire: " + lastFire);
             });
        });
    });
}

// 5. STARTUP LOGIC
// ----------------
function startStartup() {
    if (state !== "IDLE" && state !== "PURGING") return;
    print("CMD: Start Received.");
    
    // PRE-FLIGHT CHECK
    Shelly.call("Input.GetStatus", { id: I_VACUUM }, function(res) {
        if (res && !res.state) {
            print("FAILURE: Vacuum OPEN. Cannot Start.");
            lastVac = "OPEN";
            return; 
        }
        
        // SENSORS OK - START SEQUENCE
        // FIX v12.1: Clear any existing purge/shutdown timers so we don't die in 10 mins
        Timer.clear(phaseTimer);
        Timer.clear(augerTimer);

        print("SENSORS OK. IGNITION SEQUENCE STARTED.");
        state = "STARTUP";
        subState = "PRIME";
        lastVac = "OK";
        
        // Waterfall Start: Exhaust -> Conv -> Igniter -> Feed
        setRelay(R_EXHAUST, true, function() {
            setRelay(R_CONV_FAN, true, function() {
                setRelay(R_IGNITER, true, function() {
                    updateFeedParams();
                    runAugerCycle();
                    
                    // TIMING CHAIN
                    phaseTimer = Timer.set(T_PRIME * 1000, false, function() {
                        print(">>> PHASE: WAIT (No Feed)");
                        subState = "WAIT";
                        setRelay(R_AUGER, false);
                        Timer.clear(augerTimer); 
                        
                        phaseTimer = Timer.set(T_IGNITE * 1000, false, function() {
                            print(">>> PHASE: RAMP (Feed Resumed)");
                            subState = "RAMP";
                            runAugerCycle(); 
                            
                            phaseTimer = Timer.set(T_RAMP * 1000, false, function() {
                                Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(res) {
                                    if (res && res.state) {
                                        print("SUCCESS: Fire Detected. RUNNING.");
                                        state = "RUNNING";
                                        subState = "RUN";
                                        lastFire = "HOT";
                                        setRelay(R_IGNITER, false);
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
            });
        });
    });
}

// 6. EVENT LISTENERS
// ------------------
Shelly.addStatusHandler(function(status) {
    if (status.component === "input:" + I_VACUUM) {
        // FIX START: Guard Clause to prevent "Death Spiral"
        // If the stove is IDLE (Off), ignore vacuum loss signal.
        if (state === "IDLE" && status.delta.state === false) return;
        // FIX END

        if (status.delta.state === false) { 
            print("ALERT: Vacuum Lost! Debouncing...");
            lastVac = "UNSTABLE";
            vacDebounceTimer = Timer.set(DB_VACUUM, false, function() {
                print("SAFETY TRIP: Vacuum lost > 10s.");
                lastVac = "OPEN";
                stopStove(T_PURGE);
            });
        } else if (status.delta.state === true) {
            if (vacDebounceTimer) { Timer.clear(vacDebounceTimer); vacDebounceTimer = null; }
            lastVac = "OK";
        }
    }

    if (status.component === "input:" + I_POF_SNAP) {
        if (state === "RUNNING" && status.delta.state === false) {
             print("ALERT: Fire Lost! Debouncing...");
             lastFire = "UNSTABLE";
             fireDebounceTimer = Timer.set(DB_FIRE, false, function() {
                 print("SAFETY TRIP: Fire lost > 60s.");
                 lastFire = "COLD";
                 stopStove(T_PURGE);
             });
        }
        else if (state === "RUNNING" && status.delta.state === true) {
             if (fireDebounceTimer) { Timer.clear(fireDebounceTimer); fireDebounceTimer = null; }
             lastFire = "HOT";
        }
        else if (state === "STARTUP" && subState === "RAMP" && status.delta.state === true) {
             print("SUCCESS: Fire Detected Early!");
             state = "RUNNING";
             subState = "RUN";
             lastFire = "HOT";
             setRelay(R_IGNITER, false);
             Timer.clear(phaseTimer); 
        }
        else {
             lastFire = status.delta.state ? "HOT" : "COLD";
        }
    }
    
    if (status.component === "boolean:" + VS_THERMOSTAT) {
        isHighFire = status.delta.value;
        updateFeedParams();
        print("SETTINGS: Heat " + (isHighFire ? "HIGH" : "LOW"));
    }
});

// RESTORED BUTTON LISTENER
Shelly.addEventHandler(function(event) {
    let isPush = (event.info.event === "single_push" || event.info.event === "btn_down");
    let c = event.component;
    if (!isPush) return;

    // Check for Start Button (Physical or Virtual)
    if (c === "input:" + I_START_BTN || c === "button:" + V_BTN_START) {
        startStartup();
    }
    
    // Check for Stop Button (Physical or Virtual)
    if (c === "input:" + I_STOP_BTN  || c === "button:" + V_BTN_STOP) {
        stopStove(T_PURGE);
    }
    
    // Check for Force Run (Virtual Only)
    if (c === "button:" + V_BTN_FORCE) {
        print("CMD: Force Run");
        
        // Clear timers to prevent phantom shutdown
        Timer.clear(phaseTimer);
        Timer.clear(augerTimer);

        state = "RUNNING";
        subState = "RUN";
        
        // Force Waterfall Start
        setRelay(R_IGNITER, false, function() {
            setRelay(R_EXHAUST, true, function() {
                setRelay(R_CONV_FAN, true, function() {
                    runAugerCycle();
                });
            });
        });
    }
});

// 7. BOOT SEQUENCE (Serialized)
// -----------------------------
// Step 1: Safe Shutdown (Sets state to PURGING and sets a timer)
stopStove(600);

// Step 2: Sync Sensors (Delayed 2s to let Shutdown finish)
Timer.set(2000, false, function() {
    syncSensors();
});

// Step 3: Start Heartbeat Loop
Timer.set(30000, true, function() {
    syncSensors();
});
