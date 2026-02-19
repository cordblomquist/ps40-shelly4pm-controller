// WINSLOW PS40 CONTROLLER - v14.0 (Proportional Temperature Control)
// -------------------------------------------------------------------
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
// v13.3 NEW: HIGH fire ON/OFF timing read from Number:200/201 virtual components.
// v14.0 NEW: Proportional feed control via asymmetric EMA. H&T pushes room temp
//            to Number:202. Feed rate interpolates between LOW and HIGH bounds
//            based on temperature. Slow to escalate, fast to back off.

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
let V_BTN_START     = 200; 
let V_BTN_STOP      = 201; 
let V_BTN_FORCE     = 202; 
let VS_NIGHT_THERMO = 201; // Boolean:201 -- Night thermostat (56-60 deg F)
let VN_HIGH_ON      = 200; // Number:200 -- HIGH fire ON time (seconds)
let VN_HIGH_OFF     = 201; // Number:201 -- HIGH fire OFF time (seconds)
let VN_ROOM_TEMP    = 202; // Number:202 -- Room temperature (deg F, pushed by H&T)

// CONFIGURATION (Ignition Timing -- seconds)
let T_PRIME      = 90;
let T_IGNITE     = 120;
let T_RAMP       = 420;
let T_PURGE      = 1800; // 30 min -- manual/safety shutdown purge
let T_THERMO_PURGE = 900; // 15 min -- thermostat-initiated purge
let T_VAC_SETTLE = 5;    // delay after exhaust ON before vacuum check

// FEED RATE BOUNDS (ms)
// LOW_ON/LOW_OFF define the minimum auger timing -- the floor of the proportional
// range. Adjust these if the fire burns out or becomes inefficient at minimum.
let LOW_ON  = 2500;  // Minimum auger ON (ms)
let LOW_OFF = 5500;  // Minimum auger OFF (ms)
let highOn  = 4500;  // Ceiling -- synced from Number:200 every heartbeat
let highOff = 3500;  // Ceiling -- synced from Number:201 every heartbeat

// PROPORTIONAL TEMPERATURE BANDS (deg F)
// feedRatio = 1.0 at COLD threshold (full HIGH), 0.0 at WARM threshold (minimum).
// The 4-degree gap provides hysteresis for shutdown/restart cycling.
let DAY_COLD   = 67;
let DAY_WARM   = 71;
let NIGHT_COLD = 56;
let NIGHT_WARM = 60;

// EMA SMOOTHING (asymmetric)
// Slow escalation prevents overshoot from an oversized stove.
// Faster de-escalation cuts fuel quickly when the room responds.
let ALPHA_UP   = 0.08; // ~14 min to reach 90% of target (ramp up)
let ALPHA_DOWN = 0.15; // ~7 min to reach 90% of target (ramp down)

// STALENESS & SCHEDULE
let TEMP_MAX_AGE   = 3600;          // seconds -- shutdown if no temp update
let T_WARM_TIMEOUT = 30 * 60 * 1000; // 30 min at minimum feed before shutdown
let DAY_START      = 8;              // 8 AM ET
let DAY_END        = 22;             // 10 PM ET

// DEBOUNCE THRESHOLDS
let DB_VACUUM = 10 * 1000; 
let DB_FIRE   = 60 * 1000; 

// STATE
let state     = "IDLE";
let subState  = "";
let feedRatio = 0;       // 0.0 = minimum (LOW), 1.0 = maximum (HIGH). EMA-smoothed.
let activeOn  = 2500;    // Current auger ON (ms) -- computed by updateFeedParams
let activeOff = 5500;    // Current auger OFF (ms) -- computed by updateFeedParams

// TEMPERATURE STATE
let roomTemp       = 0;    // Cached from Number:202 (deg F)
let roomTempTs     = 0;    // last_update_ts from Number:202 (unix seconds)
let isDaytime      = true; // Default to daytime until NTP syncs
let nightNeedsHeat = true; // Cached Boolean:201

// TIMERS
let augerTimer        = null;
let phaseTimer        = null;
let vacDebounceTimer  = null;   
let fireDebounceTimer = null;
let warmTimer         = null; // Countdown at warm threshold before thermostat shutdown

// TELEMETRY CACHE
let lastVac  = "WAIT";    
let lastFire = "WAIT"; 

print("WINSLOW CONTROLLER v14.0: PROPORTIONAL TEMPERATURE CONTROL");

// 1. HELPER: The "Safe Switch" (Prevents RPC flooding)
// ----------------------------------------------------
function setRelay(id, st, callback) {
    Shelly.call("Switch.Set", { id: id, on: st }, function() {
        if (callback) callback();
    });
}

// 2. FEED LOGIC (EMA-Smoothed Proportional Control)
// --------------------------------------------------
// Computes a target ratio from room temperature and the active day/night band,
// then applies an asymmetric exponential moving average: slow to escalate
// (ALPHA_UP), fast to back off (ALPHA_DOWN). The ratio interpolates activeOn/
// activeOff between the LOW floor and the HIGH ceiling.
function updateFeedParams() {
    if (roomTemp <= 0) return; // No valid temp yet -- hold current feed

    let cold = isDaytime ? DAY_COLD : NIGHT_COLD;
    let warm = isDaytime ? DAY_WARM : NIGHT_WARM;

    let target = (warm - roomTemp) / (warm - cold);
    if (target < 0) target = 0;
    if (target > 1) target = 1;

    let alpha = (target > feedRatio) ? ALPHA_UP : ALPHA_DOWN;
    feedRatio = feedRatio * (1 - alpha) + target * alpha;

    activeOn  = (LOW_ON  + feedRatio * (highOn - LOW_ON)) | 0;
    activeOff = (LOW_OFF - feedRatio * (LOW_OFF - highOff)) | 0;
}

// 2b. TEMPERATURE-BASED CONTROL LOGIC
// ------------------------------------
// Manages shutdown timers and auto-restart based on room temperature.
// Called each heartbeat after updateFeedParams().
function processTemperature() {
    if (roomTemp <= 0) return;

    let warm = isDaytime ? DAY_WARM : NIGHT_WARM;
    let cold = isDaytime ? DAY_COLD : NIGHT_COLD;

    // --- RUNNING: start/cancel shutdown timer based on temperature ---
    if (state === "RUNNING") {
        if (roomTemp >= warm) {
            if (!warmTimer) {
                print("TEMP: " + roomTemp + "F >= " + warm + "F. 30-min shutdown timer started.");
                warmTimer = Timer.set(T_WARM_TIMEOUT, false, function() {
                    print("TEMP: 30 min at warm threshold. Shutting down.");
                    warmTimer = null;
                    stopStove(T_THERMO_PURGE, true);
                });
            }
        } else {
            if (warmTimer) {
                Timer.clear(warmTimer);
                warmTimer = null;
            }
        }
        return;
    }

    // --- STANDBY: auto-restart when room cools to cold threshold ---
    if (state === "STANDBY" && roomTemp <= cold) {
        if (isDaytime) {
            print("TEMP: " + roomTemp + "F <= " + cold + "F. Auto-restarting from STANDBY.");
            state = "IDLE";
            startStartup();
        } else if (nightNeedsHeat) {
            print("TEMP: Night, " + roomTemp + "F <= " + cold + "F. Auto-restarting from STANDBY.");
            state = "IDLE";
            startStartup();
        }
        return;
    }

    // --- THERMOSTAT PURGE: cancel purge and restart if room cooled ---
    if (state === "PURGING" && subState === "THERMO_COOLING" && roomTemp <= cold) {
        if (isDaytime || nightNeedsHeat) {
            print("TEMP: " + roomTemp + "F during purge. Cancelling purge, restarting.");
            Timer.clear(phaseTimer);
            state = "IDLE";
            startStartup();
        }
    }
}

// 2c. AUGER CYCLE
// ----------------
function runAugerCycle() {
    if (state !== "RUNNING" && subState !== "PRIME" && subState !== "RAMP") {
        setRelay(R_AUGER, false);
        return; 
    }

    setRelay(R_AUGER, true, function() {
        augerTimer = Timer.set(activeOn, false, function() {
            setRelay(R_AUGER, false, function() {
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
// isThermostat: true = purge ends in STANDBY (auto-restart eligible).
//               false = purge ends in IDLE (manual restart required).
function stopStove(purgeDuration, isThermostat) {
    print("!!! STOPPING STOVE" + (isThermostat ? " (THERMOSTAT)" : "") + " !!!");
    state = "PURGING"; 
    subState = isThermostat ? "THERMO_COOLING" : "COOLING";
    
    Timer.clear(augerTimer);
    Timer.clear(phaseTimer);
    Timer.clear(vacDebounceTimer); 
    Timer.clear(fireDebounceTimer);
    Timer.clear(warmTimer);
    warmTimer = null;
    
    setRelay(R_AUGER, false, function() {
        setRelay(R_IGNITER, false, function() {
            setRelay(R_EXHAUST, true, function() {
                setRelay(R_CONV_FAN, true, function() {
                    phaseTimer = Timer.set(purgeDuration * 1000, false, function() {
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
// Chain: Fire -> Vacuum -> NightThermo -> HighOn -> HighOff -> RoomTemp -> SysTime -> Logic
function syncSensors() {
    // 1. Fire
    Shelly.call("Input.GetStatus", { id: I_POF_SNAP }, function(res) {
        if (res) lastFire = res.state ? "HOT" : "COLD";
        
        // 2. Vacuum
        Shelly.call("Input.GetStatus", { id: I_VACUUM }, function(vac) {
            if (vac) lastVac = vac.state ? "OK" : "OPEN";
            
            // 3. Night Thermostat (Boolean:201)
            Shelly.call("Boolean.GetStatus", { id: VS_NIGHT_THERMO }, function(nt) {
                if (nt && typeof nt.value !== 'undefined') {
                    nightNeedsHeat = nt.value;
                }
                
                // 4. HIGH fire ON ceiling (Number:200)
                Shelly.call("Number.GetStatus", { id: VN_HIGH_ON }, function(hOn) {
                    if (hOn && typeof hOn.value === 'number' && hOn.value > 0) {
                        highOn = (hOn.value * 1000) | 0;
                    }
                    
                    // 5. HIGH fire OFF ceiling (Number:201)
                    Shelly.call("Number.GetStatus", { id: VN_HIGH_OFF }, function(hOff) {
                        if (hOff && typeof hOff.value === 'number' && hOff.value > 0) {
                            highOff = (hOff.value * 1000) | 0;
                        }
                        
                        // 6. Room Temperature (Number:202 -- pushed by H&T)
                        Shelly.call("Number.GetStatus", { id: VN_ROOM_TEMP }, function(temp) {
                            if (temp && typeof temp.value === 'number') {
                                roomTemp = temp.value;
                                if (typeof temp.last_update_ts === 'number') {
                                    roomTempTs = temp.last_update_ts;
                                }
                            }
                            
                            // 7. System Time
                            Shelly.call("Sys.GetStatus", {}, function(sys) {
                                let prevDaytime = isDaytime;
                                let unixNow = 0;
                                
                                if (sys && typeof sys.unixtime === 'number' && sys.unixtime > 0) {
                                    unixNow = sys.unixtime;
                                    if (sys.time) {
                                        let parts = sys.time.split(":");
                                        let hour = Number(parts[0]);
                                        isDaytime = (hour >= DAY_START && hour < DAY_END);
                                    }
                                }
                                
                                // STALENESS CHECK
                                if (roomTempTs > 0 && unixNow > 0 && (unixNow - roomTempTs) > TEMP_MAX_AGE) {
                                    if (state === "RUNNING" || state === "STARTUP") {
                                        let age = unixNow - roomTempTs;
                                        print("SAFETY: Temp stale (" + age + "s old). Shutting down.");
                                        stopStove(T_PURGE, false);
                                        return;
                                    }
                                }
                                
                                // EMA FEED UPDATE
                                updateFeedParams();
                                
                                // TEMPERATURE-BASED THERMOSTAT LOGIC
                                processTemperature();
                                
                                // DAY/NIGHT TRANSITION
                                if (prevDaytime !== isDaytime) {
                                    let period = isDaytime ? "DAY" : "NIGHT";
                                    print("SCHEDULE: Transitioning to " + period + " mode.");
                                }
                                
                                // HEARTBEAT
                                let period = isDaytime ? "DAY" : "NIGHT";
                                let r = "" + ((feedRatio * 100) | 0);
                                print("HB: " + state + "(" + subState + ")" +
                                      " " + roomTemp + "F" +
                                      " R:" + r + "%" +
                                      " A:" + activeOn + "/" + activeOff +
                                      " V:" + lastVac +
                                      " F:" + lastFire +
                                      " " + period);
                            });
                        });
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
    
    // Always start at minimum feed -- EMA ramps up organically
    feedRatio = 0;
    activeOn = LOW_ON;
    activeOff = LOW_OFF;

    let wasPurging = (state === "PURGING");

    Timer.clear(phaseTimer);
    Timer.clear(augerTimer);
    Timer.clear(warmTimer);
    warmTimer = null;

    setRelay(R_EXHAUST, true, function() {
        print("PRE-FLIGHT: Exhaust ON. Waiting " + T_VAC_SETTLE + "s for vacuum...");
        
        phaseTimer = Timer.set(T_VAC_SETTLE * 1000, false, function() {
            Shelly.call("Input.GetStatus", { id: I_VACUUM }, function(res) {
                if (res && !res.state) {
                    lastVac = "OPEN";
                    if (wasPurging) {
                        print("FAILURE: Vacuum OPEN. Cannot Start. Resuming purge.");
                        stopStove(T_PURGE, false);
                    } else {
                        print("FAILURE: Vacuum OPEN. Cannot Start. Exhaust OFF.");
                        setRelay(R_EXHAUST, false);
                        state = "IDLE";
                        subState = "";
                    }
                    return; 
                }
                
                print("SENSORS OK. IGNITION SEQUENCE STARTED.");
                state = "STARTUP";
                subState = "PRIME";
                lastVac = "OK";
                
                setRelay(R_CONV_FAN, true, function() {
                    setRelay(R_IGNITER, true, function() {
                        runAugerCycle();
                        
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
    // VACUUM SAFETY
    if (status.component === "input:" + I_VACUUM) {
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

    // FIRE SAFETY
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

    // NIGHT THERMOSTAT (Boolean:201)
    // Provides immediate event-driven response for nighttime auto-restart.
    // Shutdown logic is handled by processTemperature() each heartbeat.
    if (status.component === "boolean:" + VS_NIGHT_THERMO) {
        nightNeedsHeat = status.delta.value;
        if (!isDaytime) {
            print("THERMOSTAT (NIGHT): " + (nightNeedsHeat ? "HEAT NEEDED" : "WARM ENOUGH"));
            if (nightNeedsHeat && state === "STANDBY" && roomTemp > 0 && roomTemp <= NIGHT_COLD) {
                print("THERMOSTAT: Night, heat needed. Auto-restarting from STANDBY.");
                state = "IDLE";
                startStartup();
            }
        }
    }
});

// BUTTON LISTENER
Shelly.addEventHandler(function(event) {
    let isPush = (event.info.event === "single_push" || event.info.event === "btn_down");
    let c = event.component;
    if (!isPush) return;

    if (c === "input:" + I_START_BTN || c === "button:" + V_BTN_START) {
        startStartup();
    }
    
    if (c === "input:" + I_STOP_BTN || c === "button:" + V_BTN_STOP) {
        if (state === "STANDBY") {
            print("CMD: Stop in STANDBY. Moving to IDLE. Auto-restart disabled.");
            state = "IDLE";
            subState = "";
        } else {
            stopStove(T_PURGE, false);
        }
    }
    
    if (c === "button:" + V_BTN_FORCE) {
        print("CMD: Force Run");
        Timer.clear(phaseTimer);
        Timer.clear(augerTimer);
        Timer.clear(warmTimer);
        warmTimer = null;
        feedRatio = 0;
        activeOn = LOW_ON;
        activeOff = LOW_OFF;
        state = "RUNNING";
        subState = "RUN";
        setRelay(R_IGNITER, false, function() {
            setRelay(R_EXHAUST, true, function() {
                setRelay(R_CONV_FAN, true, function() {
                    runAugerCycle();
                });
            });
        });
    }
});

// 7. BOOT SEQUENCE
// ----------------
stopStove(600, false);

Timer.set(2000, false, function() {
    syncSensors();
});

Timer.set(30000, true, function() {
    syncSensors();
});
