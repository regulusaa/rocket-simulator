/**
 * ROCKET SIMULATOR - INTERNATIONAL STANDARD ATMOSPHERE (ISA) MODEL
 * =================================================================
 * Models how air properties change with altitude.
 *
 * WHY THIS MATTERS:
 *   - Air density (ρ) determines aerodynamic drag — denser air = more drag.
 *   - Temperature determines the speed of sound, which determines Mach number.
 *   - Mach number determines the drag COEFFICIENT (Cd) — transonic drag rise
 *     at Mach ~1 is why rockets slow their throttle during "Max-Q" — the point
 *     of maximum dynamic pressure on the airframe.
 *   - Dynamic pressure Q = 0.5 × ρ × v² is the primary structural loading on
 *     the rocket — too high and the vehicle can break apart.
 *
 * ATMOSPHERE LAYERS (International Standard Atmosphere):
 *   0–11 km   Troposphere: temperature decreases 6.5°C per km of altitude
 *   11–20 km  Tropopause: temperature is constant at 216.65 K (−56.5°C)
 *   20–32 km  Stratosphere: temperature increases 1°C per km of altitude
 *   >32 km    Simplified constant temperature (228.65 K)
 *   >100 km   Kármán line: start of space, density ≈ 0
 *
 * BAROMETRIC FORMULA:
 *   ρ(h) = ρ₀ × e^(−h/H) where:
 *     ρ₀ = 1.225 kg/m³ (sea-level density)
 *     H  = 8500 m (atmospheric scale height — altitude where density halves e-fold)
 *   This is a simplified exponential approximation, accurate to ~5% up to 80 km.
 *   Real ISA uses layered equations with different scale heights, but the
 *   exponential form is sufficient for this simulator.
 */

// ─── SEA-LEVEL CONSTANTS ──────────────────────────────────────────────────────

/** Sea-level air density in kg/m³ (International Standard Atmosphere). */
const RHO_0 = 1.225; // kg/m³ — standard sea-level density at 15°C, 1013.25 hPa

/** Sea-level atmospheric pressure in Pascals (1013.25 hPa). */
const P_0 = 101325; // Pa — standard sea-level pressure

/**
 * Atmospheric scale height in meters.
 * This is the altitude over which pressure and density fall by a factor of e (~2.718).
 * Real value varies 6–9 km depending on temperature; 8500 m is a good overall average.
 * At altitude H, density = ρ₀/e ≈ 45% of sea-level.
 * At altitude 2H = 17 km, density ≈ 20% of sea-level.
 * At altitude 100 km (Kármán line), density ≈ e^(−11.8) ≈ 0.00007 of sea-level ≈ 0.
 */
const H = 8500; // m — scale height for barometric formula

// ─── TEMPERATURE MODEL CONSTANTS ──────────────────────────────────────────────

/**
 * Sea-level temperature in the standard atmosphere.
 * ISA defines 288.15 K (= 15°C) as the standard sea-level temperature.
 * This is the base temperature for the tropospheric lapse rate calculation.
 */
const T_SEA_LEVEL = 288.15; // K — ISA standard sea-level temperature

/**
 * Tropopause temperature — constant from 11 km to 20 km.
 * The tropopause is the boundary between troposphere and stratosphere.
 * Temperature stops decreasing and stays at 216.65 K (−56.5°C).
 * This is the coldest layer commercial aircraft fly through.
 */
const T_TROPOPAUSE = 216.65; // K — constant temperature in tropopause layer

/**
 * Tropospheric lapse rate: how much temperature drops per meter of altitude.
 * Real value: 6.5°C per 1000 m = 0.0065 K/m (International Standard Atmosphere).
 * The decreasing temperature is why you can see your breath at mountain tops.
 */
const LAPSE_TROPOSPHERE = 6.5 / 1000; // K/m — temperature decreases 6.5°C/km

/**
 * Stratospheric lapse rate (inverted — temperature INCREASES with altitude here).
 * The stratosphere is heated from above by UV radiation absorbed by ozone.
 * Rate: +1°C per 1000 m from 20 km to 32 km.
 */
const LAPSE_STRATOSPHERE = 1.0 / 1000; // K/m — temperature increases 1°C/km above 20 km

/**
 * Simplified constant temperature used above 32 km.
 * The real stratosphere continues to ~50 km then the mesosphere begins.
 * For this simulator, we use a constant 228.65 K above 32 km.
 */
const T_ABOVE_32KM = 228.65; // K — simplified constant for upper atmosphere

// ─── GAS CONSTANTS ────────────────────────────────────────────────────────────

/**
 * Adiabatic index (ratio of specific heats) for dry air.
 * γ = Cp / Cv = 1.4 for diatomic gases like N₂ and O₂ which make up 99% of air.
 * Used in the speed of sound formula: a = √(γ × R/M × T).
 */
const GAMMA = 1.4; // dimensionless — ratio of specific heats for air

/**
 * Universal gas constant in J/(mol·K).
 * Relates energy per mole to temperature: PV = nRT.
 */
const R_GAS = 8.314; // J/(mol·K) — universal gas constant

/**
 * Molar mass of dry air in kg/mol.
 * Air is ~78% N₂ (28 g/mol) + 21% O₂ (32 g/mol) + 1% Ar (40 g/mol).
 * Effective molar mass ≈ 0.029 kg/mol.
 */
const M_AIR = 0.029; // kg/mol — molar mass of dry air

// ─── ALTITUDE OF KÁRMÁN LINE ──────────────────────────────────────────────────

/**
 * The Kármán line: internationally recognized boundary of outer space.
 * Above 100 km, air density is so low that aerodynamic lift requires orbital speed.
 * We treat density as effectively zero above this altitude.
 */
const KARMAN_LINE = 100000; // m — 100 km altitude marks the edge of space

// ─── EXPORTED FUNCTIONS ───────────────────────────────────────────────────────

/**
 * Get air temperature at a given altitude using the ISA temperature layers.
 *
 * The atmosphere is divided into layers with different temperature gradients:
 * - Troposphere (0–11 km):  decreasing at 6.5 K/km (lapse rate)
 * - Tropopause (11–20 km):  constant at 216.65 K (−56.5°C)
 * - Stratosphere (20–32 km): increasing at 1 K/km (ozone heating)
 * - Above 32 km:             simplified constant 228.65 K
 *
 * @param altitude  Altitude in meters above sea level (clamped to ≥0).
 * @returns         Temperature in Kelvin.
 */
export function getTemperature(altitude: number): number {
  // Clamp altitude to sea level minimum — negative altitudes are underground.
  const h = Math.max(0, altitude); // m — ensure non-negative altitude

  if (h < 11000) {
    // Troposphere: temperature decreases with altitude at the lapse rate.
    // T = T_sea_level − lapse_rate × altitude
    // At sea level (h=0): T = 288.15 K (15°C)
    // At 11 km:           T = 288.15 − 0.0065×11000 = 216.65 K (−56.5°C)
    return T_SEA_LEVEL - LAPSE_TROPOSPHERE * h; // K
  }

  if (h < 20000) {
    // Tropopause: temperature stays constant at 216.65 K.
    // Commercial aircraft fly at 10–12 km, right at the top of the troposphere.
    // Rockets pass through this layer rapidly during ascent.
    return T_TROPOPAUSE; // K — constant (−56.5°C)
  }

  if (h < 32000) {
    // Lower stratosphere: temperature INCREASES because ozone absorbs UV radiation.
    // T = T_tropopause + stratospheric_lapse × (altitude − 20 km)
    // At 20 km: T = 216.65 K (same as tropopause — continuous boundary)
    // At 32 km: T = 216.65 + 0.001×12000 = 228.65 K
    return T_TROPOPAUSE + LAPSE_STRATOSPHERE * (h - 20000); // K
  }

  // Above 32 km: simplified constant temperature.
  // The real atmosphere continues to vary (mesosphere, thermosphere) but for
  // this simulator the rocket is already in near-vacuum above 32 km.
  return T_ABOVE_32KM; // K — simplified constant for high altitude
}

/**
 * Get air density at a given altitude using the barometric formula.
 *
 * BAROMETRIC FORMULA: ρ(h) = ρ₀ × e^(−h/H)
 *   - Density falls exponentially with altitude.
 *   - Scale height H = 8500 m: at altitude H, density = ρ₀/e ≈ 45% of sea-level.
 *   - At 10 km: ρ ≈ 1.225 × e^(−10000/8500) ≈ 0.414 kg/m³ (~34% of sea-level)
 *   - At 50 km: ρ ≈ 1.225 × e^(−50000/8500) ≈ 0.003 kg/m³ (~0.25% of sea-level)
 *   - Above 100 km (Kármán line): treated as 0 (space vacuum)
 *
 * @param altitude  Altitude in meters (clamped to ≥0).
 * @returns         Air density in kg/m³.
 */
export function getAirDensity(altitude: number): number {
  // Clamp to ground level — underground density doesn't make physical sense here.
  const h = Math.max(0, altitude); // m — non-negative altitude

  // Above the Kármán line (100 km): space, density is negligible.
  // In reality density ≈ 5×10⁻⁷ kg/m³ at 100 km, but we treat it as 0.
  if (h >= KARMAN_LINE) {
    return 0; // kg/m³ — effectively zero in space
  }

  // Barometric formula: exponential decay with altitude.
  // Math.exp(−h/H): at h=0 → 1.0, at h=H → 1/e ≈ 0.368, at h=2H → 1/e² ≈ 0.135.
  return RHO_0 * Math.exp(-h / H); // kg/m³
}

/**
 * Get atmospheric pressure at a given altitude using the barometric formula.
 *
 * Uses the same exponential decay formula as density, since pressure and density
 * are directly proportional in an isothermal atmosphere (ideal gas law: P = ρRT/M).
 *
 * @param altitude  Altitude in meters (clamped to ≥0).
 * @returns         Air pressure in Pascals.
 */
export function getAirPressure(altitude: number): number {
  // Clamp to ground level.
  const h = Math.max(0, altitude); // m

  // No pressure in space (above Kármán line).
  if (h >= KARMAN_LINE) {
    return 0; // Pa — vacuum of space
  }

  // Pressure barometric formula: P(h) = P₀ × e^(−h/H).
  // At sea level: P = 101325 Pa (1 atm).
  // At 10 km: P ≈ 101325 × e^(−10000/8500) ≈ 34,278 Pa (~34% of sea-level).
  return P_0 * Math.exp(-h / H); // Pa
}

/**
 * Get the speed of sound at a given altitude.
 *
 * SPEED OF SOUND FORMULA: a = √(γ × R × T / M)
 *   Where:
 *     γ = 1.4  (adiabatic index for air)
 *     R = 8.314 J/(mol·K) (universal gas constant)
 *     T = temperature in Kelvin at this altitude
 *     M = 0.029 kg/mol (molar mass of air)
 *
 *   Speed of sound DEPENDS on temperature, not pressure or density directly.
 *   At sea level (288.15 K): a ≈ 340 m/s (Mach 1 ≈ 340 m/s at ground level)
 *   At 11 km (216.65 K):     a ≈ 295 m/s (Mach 1 is slower in cold air)
 *   At 32 km (228.65 K):     a ≈ 303 m/s (slightly warmer stratosphere)
 *
 * WHY IT MATTERS: Mach number = velocity / speed_of_sound.
 *   A rocket going 300 m/s at sea level is at Mach 0.88 (subsonic).
 *   The same rocket at 15 km is at Mach ~1.0 (transonic, highest drag).
 *
 * @param altitude  Altitude in meters.
 * @returns         Speed of sound in m/s.
 */
export function getSpeedOfSound(altitude: number): number {
  // Get temperature at this altitude using the ISA temperature model.
  const T = getTemperature(altitude); // K — current atmospheric temperature

  // Speed of sound formula: a = √(γ × R × T / M)
  // γ × R / M = 1.4 × 8.314 / 0.029 = 401.2 m²/(s²·K)
  // At 288.15 K: a = √(401.2 × 288.15) = √115,576 ≈ 340 m/s ✓
  return Math.sqrt(GAMMA * R_GAS * T / M_AIR); // m/s
}

/**
 * Calculate the Mach number: ratio of rocket speed to local speed of sound.
 *
 * MACH NUMBER REGIMES:
 *   M < 0.8:   Subsonic — airflow stays attached, low wave drag
 *   M 0.8–1.2: Transonic — mixed subsonic/supersonic flow, high wave drag ("sound barrier")
 *   M > 1.2:   Supersonic — shock wave forms at nose, drag drops relative to transonic peak
 *   M > 5:     Hypersonic — extreme heating, very different aerodynamics
 *
 * WHY MACH MATTERS:
 *   The drag coefficient (Cd) peaks sharply in the transonic regime.
 *   This is the "sound barrier" — not a real wall, but significantly higher drag.
 *   Real rockets throttle back slightly at Max-Q to avoid structural overload.
 *
 * @param velocity  Velocity magnitude in m/s (always positive).
 * @param altitude  Altitude in meters.
 * @returns         Mach number (dimensionless, 0+ range).
 */
export function getMachNumber(velocity: number, altitude: number): number {
  // Speed is the magnitude of the velocity vector — Mach is always non-negative.
  const speed = Math.abs(velocity); // m/s — ensure positive

  // Get local speed of sound at this altitude.
  const a = getSpeedOfSound(altitude); // m/s — local sound speed

  // Avoid division by zero (extremely rare: temperature near absolute zero in space).
  if (a <= 0) {
    return 0; // Mach 0 if no speed of sound (unreachable atmosphere)
  }

  // Mach number = vehicle speed / speed of sound.
  // At M=1.0 the rocket is exactly at the speed of sound (sonic).
  // Above M=1.0 the rocket is supersonic (faster than sound).
  return speed / a; // dimensionless Mach number
}

/**
 * Calculate dynamic pressure Q at a given velocity and altitude.
 *
 * DYNAMIC PRESSURE: Q = 0.5 × ρ × v²
 *   - ρ = air density (decreases with altitude)
 *   - v = velocity (increases during ascent)
 *
 * WHY IT MATTERS — MAX-Q:
 *   Q is the single most important aerodynamic loading on a rocket.
 *   As the rocket climbs, ρ decreases but v increases.
 *   Q starts low (on the pad), peaks ("Max-Q") around 11–14 km altitude, then
 *   falls as the air becomes too thin to exert significant force.
 *   All rocket launches throttle back at Max-Q to protect the vehicle.
 *   SpaceX Falcon 9 Max-Q is about 33 kPa at approximately 12 km altitude.
 *
 * UNITS: Q is in Pascals (Pa). 1 Pa = 1 N/m².
 *   At Max-Q (~33 kPa), the rocket nose experiences 33 kN/m² of pressure.
 *   This is equivalent to about 330 kg pushing on every square meter of surface.
 *
 * @param velocity  Velocity magnitude in m/s.
 * @param altitude  Altitude in meters.
 * @returns         Dynamic pressure in Pascals (Pa).
 */
export function getDynamicPressure(velocity: number, altitude: number): number {
  // Get air density at this altitude (kg/m³).
  const rho = getAirDensity(altitude); // kg/m³

  // Q = ½ρv² — kinetic energy density of the airstream hitting the rocket.
  // At higher altitudes, ρ decreases faster than v² increases, so Q eventually falls.
  return 0.5 * rho * velocity * velocity; // Pa = kg/(m·s²)
}

/**
 * Get the Mach-dependent drag coefficient (Cd).
 *
 * DRAG COEFFICIENT vs MACH NUMBER:
 *   The drag coefficient is NOT constant — it depends strongly on Mach number.
 *   This is the key reason why the "sound barrier" was a challenge in aerospace.
 *
 *   Cd profile:
 *     M < 0.8  (subsonic):    Cd = 0.3  — attached flow, low wave drag
 *     M 0.8–1.2 (transonic):  Cd rises linearly to 0.6 — shock waves forming
 *     M > 1.2 (supersonic):   Cd drops to 0.2 — fully formed oblique shock
 *     M > 5  (hypersonic):    Cd = 0.15 — very thin shock layer
 *
 *   The transonic drag rise is called the "sound barrier" effect.
 *   Chuck Yeager broke the sound barrier in 1947 partly because designers
 *   used a very thin wing shape that reduced the transonic Cd peak.
 *   Modern rockets are designed to pass through Mach 1 quickly to minimize
 *   time spent in the high-drag transonic regime.
 *
 * @param mach  Current Mach number.
 * @returns     Drag coefficient Cd (dimensionless).
 */
export function getDragCoefficient(mach: number): number {
  if (mach < 0.8) {
    // Subsonic flow: clean attached airflow around the nose cone.
    // Cd = 0.3 is typical for a well-designed rocket nose cone (subsonic).
    return 0.3; // dimensionless — subsonic drag coefficient
  }

  if (mach < 1.2) {
    // Transonic regime: shock waves begin forming at the nose and body.
    // Cd rises linearly from 0.3 (at M=0.8) to 0.6 (at M=1.2).
    // This is the "sound barrier" — highest drag, most structural loading.
    // Real rockets throttle down here to reduce aerodynamic forces (Max-Q control).
    const t = (mach - 0.8) / 0.4; // Linear interpolation from 0.8 to 1.2
    return 0.3 + t * 0.3; // Cd rises from 0.3 → 0.6 linearly across transonic
  }

  if (mach < 5.0) {
    // Supersonic regime: a stable oblique shock wave forms at the nose.
    // The shock "stands off" the nose, and Cd drops significantly to 0.2.
    // Counterintuitively, it's EASIER to fly supersonic than transonic once
    // you've accelerated past Mach 1.2.
    return 0.2; // dimensionless — supersonic drag coefficient
  }

  // Hypersonic regime (M > 5): very thin shock layer attached to the nose.
  // Cd drops further to 0.15 as boundary layer effects dominate.
  // Aerodynamic heating becomes the critical issue at hypersonic speeds.
  return 0.15; // dimensionless — hypersonic drag coefficient
}
