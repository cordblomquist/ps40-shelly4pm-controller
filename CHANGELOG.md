# Changelog

All notable changes to the Winslow PS40 Pellet Stove Controller.

## v14.8 -- 2026-02-21

### Fixed
- Pressing Start during a boot purge (when room is warm) would cancel the purge timer but fail to turn off relays, leaving exhaust and convection fans running indefinitely in STANDBY. Now properly turns off fans if stove is cold, or lets purge finish before entering STANDBY if stove is hot.

## v14.7 -- 2026-02-21

### Changed
- Decreased `ALPHA_UP` from `0.08` to `0.04`. EMA ramp-up now takes ~29 min to reach 90% of target (up from ~14 min). Results in longer, lower burns.

## v14.6 -- 2026-02-21

### Changed
- Reduced HIGH feed rate bounds again (`HIGH_ON: 3500ms`, `HIGH_OFF: 4500ms`). Ratio is now ~1.4x, preventing the stove from getting too hot to the touch.

## v14.5 -- 2026-02-21

### Added
- Pressing Start when room is already above cold threshold puts stove directly into STANDBY instead of running ignition.

### Fixed
- Purge timers properly cleared when entering STANDBY via Start button, preventing phantom shutdown to IDLE.

### Changed
- Reduced HIGH feed rate bounds (`HIGH_ON: 4500ms`, `HIGH_OFF: 3500ms`). Ratio is now ~1.8x.
- Local python logger (`stove-logger.py`) updated to filter out noisy RPC logs, showing only script outputs.

## v14.4 -- 2026-02-20

### Fixed
- Clear purge timer when entering STANDBY via start button to prevent phantom shutdown.

## v14.3 -- 2026-02-20

### Added
- Start logic allows standby mode if room is already warm.

### Changed
- Reduced max feed rate to prevent overheating.

## v14.2 -- 2026-02-18

### Added
- Tunable temperature bands via Shelly app: Day Cold (`Number:200`), Night Cold (`Number:201`), Hysteresis (`Number:203`).
- Heartbeat now shows temperature bands: `D:67-71 N:56-60`.

### Changed
- Feed rates hardcoded per PS40 spec. LOW: 2500ms ON / 5500ms OFF. HIGH: 6500ms ON / 1500ms OFF (~2.5x ratio).

### Removed
- Number:200-201 (feed timing sliders), Number:203-204 (low fire sliders). Replaced by hardcoded constants and temperature bands.

## v14.1 -- 2026-02-18

### Added
- All operational parameters tunable from Shelly app (feed rates, schedule hours).

### Removed
- Boolean:201 (Night thermostat toggle). Temperature + schedule handles everything.

## v14.0 -- 2026-02-18

### Added
- Proportional temperature control via asymmetric EMA. Feed rate scales continuously based on room temperature from Shelly H&T Gen3 sensor.
- Asymmetric smoothing: slow to escalate (ALPHA_UP), fast to back off (ALPHA_DOWN). Prevents overshoot from oversized stove.
- Temperature staleness safety: >1 hour without H&T update triggers automatic shutdown.

### Removed
- Boolean:200 (Thermostat toggle). Replaced by continuous proportional control.

## v13.3 -- 2026-02-18

### Added
- Cloud-tunable HIGH fire feed rates via Number:200/201.

### Fixed
- Boot banner version string (was showing v13.2 instead of v13.3).

## v13.2 -- 2026-02-17

### Fixed
- Resume purge on vacuum failure during start-from-PURGE. Previously would get stuck.

## v13.1 -- 2026-02-17

### Fixed
- Vacuum pre-flight check for cold start and STANDBY auto-restart. Exhaust fan now runs for `T_VAC_SETTLE` seconds before checking vacuum.

## v13.0 -- 2026-02-17

### Added
- Thermostat auto-control via Shelly H&T Gen3 sensor.
- Day/night schedule-based temperature thresholds.
- STANDBY state for auto-restart when room cools.
- `.gitignore` for secrets and local tooling.

## v12.1 -- 2026-01-18

### Fixed
- Clear purge timer on Start to prevent phantom shutdown 10 min after boot.

## v12.0 -- 2026-01-18

### Changed
- Complete rewrite to Waterfall RPC architecture. All hardware actuation serialized via callbacks to prevent exceeding Shelly's 5-concurrent-call limit.
- Event-driven design using `Shelly.addStatusHandler` and `Shelly.addEventHandler` instead of polling.

## v5.1 -- 2025-12-14

### Changed
- Sync loop now explicitly checks thermostat state before calculating feed rate. Guarantees stove matches switch state within 10 seconds even if event is missed.

## v5.0 -- 2025-12-13

### Added
- Fail-safe boot: on power-up, fans ON and 10-min safety purge.
- Active polling: checks virtual slider values every 10 seconds.
- Debounce logic: filters electronic noise to prevent false shutdowns.
- Force Run button: bypass ignition sequence if fire is already burning.

## v4.0 -- 2025-12-12

### Added
- Hot start functionality to cut ignition time short when fire is already present.

### Changed
- Feed rates adjusted for better combustion.
- Debounce timing adjusted for shutdown reliability.

## v3.0 -- 2025-11-30

### Changed
- Ignition timing updated to match actual stove behavior: 0:00-1:30 auger on non-stop, 1:30-3:30 auger stopped, 3:30-11:00 auger 4s on/4s off.

## v1.0 -- 2025-11-29

### Added
- Initial release. Basic relay control for Shelly Pro 4PM replacing factory control board.
- Wiring diagram and readme documentation.
