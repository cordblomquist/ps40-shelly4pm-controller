// WINSLOW PS40 CONTROLLER - v13.2 (Purge-Safe Vacuum Failure)
// ------------------------------------------------------------
// ARCHITECTURE: Waterfall RPC (Serialized Calls), Event-Driven
// v12.1 FIX: Clears boot/purge timers on Start to prevent phantom shutdown.
// v13.0 NEW: Room thermostat auto-control via Shelly H&T Gen3.
//            Day/night schedules, STANDBY state, auto-restart.
// v13.1 FIX: Start exhaust fan before vacuum check so negative pressure can
//            establish. Fixes "Vacuum OPEN" failure on cold start and STANDBY
//            auto-restart (vacuum switch requires airflow to close).
// v13.2 FIX: On vacuum failure during a start-from-PURGE, resume purge instead
//            of going to IDLE. Keeps exhaust fan running when residual fire is
//            possible and prevents orphaned convection fan.

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
let V_BTN_START    = 200; 
let V_BTN_STOP     = 201; 
let V_BTN_FORCE    = 202; 
let VS_DAY_THERMO  = 200;  // Boolean:200 — Day thermostat (68-72°F range)
let VS_NIGHT_THERMO = 201; // Boolean:201 — Night thermostat (55-60°F range)

// CONFIGURATION (Seconds)
let T_PRIME        = 90;
let T_IGNITE       = 120;
let T_RAMP         = 420;
let T_PURGE        = 1800;  // 30 min — manual/safety shutdown purge
let T_THERMO_PURGE = 900;   // 15 min — thermostat-initiated purge
let T_VAC_SETTLE   = 5;     // seconds — delay after exhaust ON before vacuum check

// THERMOSTAT CONFIGURATION
let T_LOW_TIMEOUT  = 30 * 60 * 1000; // 30 min in ms — LOW fire before shutdown
let DAY_START      = 8;               // 8 AM ET — start of daytime schedule
let DAY_END        = 22;              // 10 PM ET — end of daytime schedule

// DEBOUNCE THRESHOLDS
let DB_VACUUM = 10 * 1000; 
let DB_FIRE   = 60 * 1000; 

// STATE
// Valid states: IDLE, STARTUP, RUNNING, PURGING, STANDBY
let state = "IDLE";
let subState = "";
let isHighFire = false;
let activeOn  = 3000;   
let activeOff = 5000; 

// THERMOSTAT STATE
let isDaytime      = true;   // Default to daytime until NTP syncs
let dayNeedsHeat   = true;   // Cached Boolean:200 (true = temp < 68°F)
let nightNeedsHeat = true;   // Cached Boolean:201 (true = temp < 55°F)

// TIMERS
let augerTimer = null;
let phaseTimer = null;
let vacDebounceTimer = null;   
let fireDebounceTimer = null;
let lowFireTimer = null;       // 30-min LOW fire countdown before thermostat shutdown

// TELEMETRY CACHE
let lastVac = "WAIT";    
let lastFire = "WAIT"; 

print("WINSLOW CONTROLLER v13.2: THERMOSTAT AUTO-CONTROL");

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

// 2b. THERMOSTAT HELPER: Returns the active thermostat signal based on time of day
// ---------------------------------------------------------------------------------
function activeNeedsHeat() {
    return isDaytime ? dayNeedsHeat : nightNeedsHeat;
}

// 2c. THERMOSTAT LOGIC: Processes changes from the active thermostat boolean
// --------------------------------------------------------------------------
// Called when: (a) the active boolean changes, (b) day/night transition occurs.
// Only acts when state is RUNNING, STANDBY, or thermostat-initiated PURGING.
function processThermostatChange(needsHeat) {

    // --- RUNNING: Step down, step up, or begin shutdown ---
    if (state === "RUNNING") {
        if (!needsHeat) {
            // Room is warm enough. Switch to LOW fire and start countdown.
            if (isHighFire) {
                isHighFire = false;
                updateFeedParams();
                print("THERMOSTAT: Room warm. Stepping down to LOW fire.");
            }
            // Start (or restart) the 30-min LOW fire countdown
            Timer.clear(lowFireTimer);
            lowFireTimer = Timer.set(T_LOW_TIMEOUT, false, function() {
                print("THERMOSTAT: LOW fire timeout (30 min). Shutting down.");
                lowFireTimer = null;
                stopStove(T_THERMO_PURGE, true);
            });
        } else {
            // Room needs heat. Cancel any shutdown countdown, go to HIGH.
            if (lowFireTimer) {
                Timer.clear(lowFireTimer);
                lowFireTimer = null;
                print("THERMOSTAT: Room cooling. Cancelling shutdown timer.");
            }
            if (!isHighFire) {
                isHighFire = true;
                updateFeedParams();
                print("THERMOSTAT: Stepping up to HIGH fire.");
            }
        }
        return;
    }

    // --- STANDBY: Auto-restart if room needs heat ---
    if (state === "STANDBY" && needsHeat) {
        print("THERMOSTAT: Room needs heat. Auto-restarting from STANDBY.");
        state = "IDLE";
        startStartup();
        return;
    }

    // --- THERMOSTAT PURGE: Cancel purge and restart if room needs heat ---
    if (state === "PURGING" && subState === "THERMO_COOLING" && needsHeat) {
        print("THERMOSTAT: Room needs heat during purge. Cancelling purge, restarting.");
        Timer.clear(phaseTimer);
        state = "IDLE";
        startStartup();
        return;
    }
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
// isThermostat: if true, purge ends in STANDBY (auto-restart eligible).
//               if false/undefined, purge ends in IDLE (manual restart required).
function stopStove(purgeDuration, isThermostat) {
    print("!!! STOPPING STOVE" + (isThermostat ? " (THERMOSTAT)" : "") + " !!!");
    state = "PURGING"; 
    subState = isThermostat ? "THERMO_COOLING" : "COOLING";
    
    // Kill all running timers
    Timer.clear(augerTimer);
    Timer.clear(phaseTimer);
    Timer.clear(vacDebounceTimer); 
    Timer.clear(fireDebounceTimer);
    Timer.clear(lowFireTimer);
    lowFireTimer = null;
    
    // WATERFALL SEQUENCE: Auger -> Igniter -> Exhaust -> Fan
    setRelay(R_AUGER, false, function() {
        setRelay(R_IGNITER, false, function() {
            setRelay(R_EXHAUST, true, function() {
                setRelay(R_CONV_FAN, true, function() {
                    
                    // Set Purge Timer
                    phaseTimer = Timer.set(purgeDuration * 1000, false, function() {
                        // Thermostat shutdown -> STANDBY (auto-restart eligible)
                        // Manual/safety shutdown -> IDLE (manual restart required)
                        if (subState === "THERMO_COOLING") {
                            print("Thermostat Purge Complete. Entering STANDBY.");
                            state = "STANDBY";
                            subState = "";
                        } else {
                            print("Purge Complete. Fans OFF.");
                            state = "IDLE";
                            subState = "";
                        }
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
// Serialized chain: Fire -> Vacuum -> DayThermo -> NightThermo -> SysTime -> Print
function syncSensors() {
    // 1. Check Fire
    Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(res) {
        if (res) lastFire = res.state ? "HOT" : "COLD";
        
        // 2. Check Vacuum
        Shelly.call("Input.GetStatus", { id: I_VACUUM }, function(vac) {
             if (vac) lastVac = vac.state ? "OK" : "OPEN";
             
             // 3. Check Day Thermostat (Boolean:200)
             Shelly.call("Boolean.GetStatus", { id: VS_DAY_THERMO }, function(dayTherm) {
                 if (dayTherm && typeof dayTherm.value !== 'undefined') {
                     dayNeedsHeat = dayTherm.value;
                 }
                 
                 // 4. Check Night Thermostat (Boolean:201)
                 Shelly.call("Boolean.GetStatus", { id: VS_NIGHT_THERMO }, function(nightTherm) {
                     if (nightTherm && typeof nightTherm.value !== 'undefined') {
                         nightNeedsHeat = nightTherm.value;
                     }
                     
                     // 5. Check System Time for day/night schedule
                     Shelly.call("Sys.GetStatus", {}, function(sys) {
                         let prevDaytime = isDaytime;
                         
                         if (sys && typeof sys.unixtime === 'number' && sys.unixtime > 0) {
                             // Shelly reports local time in sys.time as "HH:MM"
                             if (sys.time) {
                                 let parts = sys.time.split(":");
                                 let hour = Number(parts[0]);
                                 isDaytime = (hour >= DAY_START && hour < DAY_END);
                             }
                         }
                         // If NTP hasn't synced yet (unixtime === 0), isDaytime stays true (safe default)
                         
                         // Sync isHighFire to the active thermostat signal
                         let activeSignal = activeNeedsHeat();
                         isHighFire = activeSignal;
                         updateFeedParams();
                         
                         // Handle day/night transition: re-evaluate thermostat with new active boolean
                         if (prevDaytime !== isDaytime) {
                             let period = isDaytime ? "DAY" : "NIGHT";
                             print("SCHEDULE: Transitioning to " + period + " mode.");
                             processThermostatChange(activeSignal);
                         }
                         
                         // DONE: Print Heartbeat
                         let mode = isHighFire ? "HIGH" : "LOW";
                         let period = isDaytime ? "DAY" : "NIGHT";
                         print("HEARTBEAT: " + state + " (" + subState + ") | Heat: " + mode + 
                               " | Vac: " + lastVac + " | Fire: " + lastFire +
                               " | Schedule: " + period);
                     });
                 });
             });
        });
    });
}

// 5. STARTUP LOGIC
// ----------------
function startStartup() {
    if (state !== "IDLE" && state !== "PURGING") return;
    print("CMD: Start Received.");
    
    // FIX v13.2: Remember if we're interrupting a purge. On vacuum failure,
    // we must resume the purge (fans stay on) rather than going to IDLE,
    // because there may be residual fire that needs venting.
    let wasPurging = (state === "PURGING");

    // FIX v12.1: Clear any existing purge/shutdown timers so we don't die in 10 mins
    Timer.clear(phaseTimer);
    Timer.clear(augerTimer);

    // PRE-FLIGHT: Start exhaust fan first, then verify vacuum.
    // The vacuum switch requires negative pressure from the exhaust fan to close,
    // so we must spin up the fan and wait before checking.
    setRelay(R_EXHAUST, true, function() {
        print("PRE-FLIGHT: Exhaust ON. Waiting " + T_VAC_SETTLE + "s for vacuum...");
        
        phaseTimer = Timer.set(T_VAC_SETTLE * 1000, false, function() {
            Shelly.call("Input.GetStatus", { id: I_VACUUM }, function(res) {
                if (res && !res.state) {
                    lastVac = "OPEN";
                    if (wasPurging) {
                        // Residual fire possible — keep fans running, resume a clean purge
                        print("FAILURE: Vacuum OPEN. Cannot Start. Resuming purge.");
                        stopStove(T_PURGE, false);
                    } else {
                        // Cold start from IDLE/STANDBY — safe to turn off exhaust
                        print("FAILURE: Vacuum OPEN. Cannot Start. Exhaust OFF.");
                        setRelay(R_EXHAUST, false);
                        state = "IDLE";
                        subState = "";
                    }
                    return; 
                }
                
                // VACUUM OK — BEGIN IGNITION SEQUENCE
                print("SENSORS OK. IGNITION SEQUENCE STARTED.");
                state = "STARTUP";
                subState = "PRIME";
                lastVac = "OK";
                
                // Waterfall: Conv -> Igniter -> Feed (Exhaust already ON)
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
                                            stopStove(T_PURGE, false);
                                        }
                                    });
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
        // Guard: Ignore vacuum loss when stove is off (IDLE or STANDBY)
        if ((state === "IDLE" || state === "STANDBY") && status.delta.state === false) return;

        if (status.delta.state === false) { 
            print("ALERT: Vacuum Lost! Debouncing...");
            lastVac = "UNSTABLE";
            vacDebounceTimer = Timer.set(DB_VACUUM, false, function() {
                print("SAFETY TRIP: Vacuum lost > 10s.");
                lastVac = "OPEN";
                stopStove(T_PURGE, false);
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
                 stopStove(T_PURGE, false);
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
    
    // DAY THERMOSTAT (Boolean:200) — Cloud sets true when temp < 68°F, false when > 72°F
    if (status.component === "boolean:" + VS_DAY_THERMO) {
        dayNeedsHeat = status.delta.value;
        if (isDaytime) {
            isHighFire = dayNeedsHeat;
            updateFeedParams();
            print("THERMOSTAT (DAY): " + (dayNeedsHeat ? "HEAT NEEDED" : "WARM ENOUGH"));
            processThermostatChange(dayNeedsHeat);
        }
    }

    // NIGHT THERMOSTAT (Boolean:201) — Cloud sets true when temp < 55°F, false when > 60°F
    if (status.component === "boolean:" + VS_NIGHT_THERMO) {
        nightNeedsHeat = status.delta.value;
        if (!isDaytime) {
            isHighFire = nightNeedsHeat;
            updateFeedParams();
            print("THERMOSTAT (NIGHT): " + (nightNeedsHeat ? "HEAT NEEDED" : "WARM ENOUGH"));
            processThermostatChange(nightNeedsHeat);
        }
    }
});

// BUTTON LISTENER
Shelly.addEventHandler(function(event) {
    let isPush = (event.info.event === "single_push" || event.info.event === "btn_down");
    let c = event.component;
    if (!isPush) return;

    // START BUTTON (Physical or Virtual)
    // Note: startStartup() only allows IDLE or PURGING. STANDBY is intentionally
    // excluded — the stove should only restart from STANDBY via thermostat signal.
    if (c === "input:" + I_START_BTN || c === "button:" + V_BTN_START) {
        startStartup();
    }
    
    // STOP BUTTON (Physical or Virtual)
    if (c === "input:" + I_STOP_BTN  || c === "button:" + V_BTN_STOP) {
        if (state === "STANDBY") {
            // STANDBY -> IDLE: Disable auto-restart, require manual start
            print("CMD: Stop in STANDBY. Moving to IDLE. Auto-restart disabled.");
            state = "IDLE";
            subState = "";
        } else {
            // Normal shutdown with full 30-min purge
            stopStove(T_PURGE, false);
        }
    }
    
    // FORCE RUN (Virtual Only)
    if (c === "button:" + V_BTN_FORCE) {
        print("CMD: Force Run");
        
        // Clear all timers to prevent phantom shutdown
        Timer.clear(phaseTimer);
        Timer.clear(augerTimer);
        Timer.clear(lowFireTimer);
        lowFireTimer = null;

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
// Step 1: Safe Shutdown (not thermostat-initiated — boots to IDLE, not STANDBY)
stopStove(600, false);

// Step 2: Sync Sensors (Delayed 2s to let Shutdown finish)
Timer.set(2000, false, function() {
    syncSensors();
});

// Step 3: Start Heartbeat Loop
Timer.set(30000, true, function() {
    syncSensors();
});