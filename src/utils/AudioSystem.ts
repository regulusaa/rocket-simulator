/**
 * ROCKET SIMULATOR - AUDIO SYSTEM
 * ================================
 * Complete audio management for sound effects in the simulator.
 *
 * WEB AUDIO API PRIMER:
 *   Browsers have two ways to play audio:
 *
 *   1. <audio> / HTMLAudioElement — the classic way:
 *      Load an MP3 file, call .play().  Simple but limited:
 *        - Can't control pitch precisely
 *        - Multiple overlapping plays need multiple <audio> elements
 *        - High latency for triggered sounds (not great for game audio)
 *
 *   2. Web Audio API (AudioContext) — the powerful way:
 *      A graph of audio nodes that process sound in real time:
 *        OscillatorNode → GainNode → AudioContext.destination → speakers
 *        ^^ generates tone   ^^ controls volume
 *      Advantages:
 *        - Sub-millisecond scheduling accuracy
 *        - Procedural sounds (no audio files needed)
 *        - PITCH shift via playbackRate on AudioBufferSourceNode
 *        - Volume envelopes (smooth fade-in/out) via GainNode.gain.rampToValue
 *
 *   This file uses BOTH:
 *     - HTMLAudioElement pools for file-based sounds (when we have MP3s)
 *     - AudioContext oscillators for UI beeps and warning sounds (no files needed)
 *
 * AUDIO POOLING EXPLAINED:
 *   Each time you call `new Audio()` you create a new DOM element and load a new
 *   audio buffer. Creating DOM elements during gameplay causes jank (frame stutters)
 *   because it forces the browser to allocate memory mid-frame.
 *
 *   Solution: create all AudioElements at startup, pool them, and reuse them.
 *   AudioPool.acquire() grabs a ready element; AudioPool.release() returns it
 *   after the sound finishes. Zero allocation during gameplay = no GC pressure.
 *
 *   This is the same pattern used in game engines for bullets, particles, etc.
 *
 * PROCEDURAL SOUND DESIGN:
 *   Real rockets have:
 *     - Engine roar: pink noise filtered through a low-pass filter (~200 Hz)
 *     - Stage separation: a sharp crack + low rumble
 *     - Warning beeps: 500 Hz square wave at 3× (triple-beep pattern)
 *   We approximate these with Web Audio oscillators since we have no audio files.
 *   The OscillatorSound class generates sine/square waves at specific frequencies.
 *
 *   FREQUENCY GUIDE (musical + engineering context):
 *     200 Hz — engine rumble frequency (sub-bass region, "chest thump" feeling)
 *     500 Hz — warning beep (distinct, attention-getting, mid range)
 *     600 Hz — UI click confirmation (pleasant, not jarring)
 *     800 Hz — secondary UI sound (slightly higher, pairs well with 600 Hz)
 *   Sine waves sound smooth (pure tone). Square waves sound buzzy (richer harmonics).
 */

// ─── SOUND EFFECT TYPES ───────────────────────────────────────────────────────

/**
 * Every possible sound effect in the simulator.
 * Using a TypeScript union type ensures we can only play sounds that are registered.
 * If you add a new sound but forget to add it here, TypeScript will catch the error.
 *
 * DESIGN DECISION: string literal union vs enum?
 *   Union type ("a" | "b") is preferred in modern TypeScript because:
 *   - The values ARE the names (no separate number mapping)
 *   - Better ergonomics with autocomplete
 *   - Easier to serialize to JSON (no reverse-mapping needed)
 */
export type SoundEffect =
  | "engine-ignition"    // Short burst when engine first fires (one-shot)
  | "engine-thrust"      // Continuous roar while engine is thrusting (looping)
  | "stage-separation"   // Explosive bang when a stage is jettisoned
  | "parachute-deploy"   // Whoosh as the parachute billows open
  | "landing-soft"       // Gentle thump for a good touchdown (< 5 m/s)
  | "landing-hard"       // Metallic crash for a hard impact (> 20 m/s)
  | "ui-click"           // Click feedback for button presses
  | "ui-select"          // Two-tone chime for dropdown selection changes
  | "warning-beep"       // Three-beep alert for engine failures / structural warnings
  | "thrust-increase"    // Audio cue when throttle ramps up significantly
  | "thrust-decrease";   // Audio cue when throttle drops significantly

// ─── SOUND CONFIGURATION ─────────────────────────────────────────────────────

/**
 * Full configuration for one sound effect.
 * Stored in a Map so we can look up settings by SoundEffect type in O(1).
 */
export interface SoundConfig {
  /**
   * URL or data URL to the audio file.
   * Empty string means "use oscillator (procedural sound)" — no file needed.
   * Set via AudioManager.setAudioSource() if you add actual audio files later.
   */
  source: string;

  /**
   * Whether this sound loops (repeats when it reaches the end).
   * Only the engine-thrust sound loops; all others are one-shot.
   * Looping is essential for the continuous engine roar — it would restart
   * after each clip otherwise.
   */
  loop: boolean;

  /**
   * Default volume for this sound (0 = silent, 1 = full volume).
   * This is the "base" volume that gets multiplied by master × category × user.
   * Keep explosion sounds louder (0.8–0.9) than UI sounds (0.4) for realism.
   */
  volume: number;

  /**
   * Whether this sound's pitch (playbackRate) varies.
   * Useful for engine sounds where higher throttle = higher pitch frequency.
   * When true, a random pitch between pitchMin and pitchMax is chosen at play time.
   * This natural variation prevents repetitive "looped sample" artifacts.
   */
  pitchVariation: boolean;

  /**
   * Minimum pitch multiplier (1.0 = original pitch, 0.5 = one octave lower).
   * Applied to HTMLAudioElement.playbackRate, which slows/speeds the audio file.
   */
  pitchMin: number;

  /**
   * Maximum pitch multiplier (1.2 = slightly higher than original, 2.0 = one octave up).
   */
  pitchMax: number;

  /**
   * Sound category used for grouped volume control.
   * Allows players to independently adjust engine/explosion/UI volumes.
   *   "engine" — thrust, ignition, separation sounds
   *   "explosion" — landing, crash
   *   "ui" — button clicks, selections
   *   "environment" — ambient wind, parachute
   *   "warning" — beep alerts
   */
  category: "engine" | "explosion" | "ui" | "environment" | "warning";

  /**
   * Maximum number of this sound that can play simultaneously.
   * "engine-thrust" = 1 (only one engine sound at a time).
   * "ui-click" = 4 (rapid clicks can stack slightly).
   * This prevents audio chaos when many events fire close together.
   */
  maxInstances: number;
}

// ─── AUDIO POOL ───────────────────────────────────────────────────────────────

/**
 * AudioPool manages a fixed set of HTMLAudioElement instances for one sound type.
 *
 * OBJECT POOLING PATTERN (applied to audio):
 *   Imagine you run a restaurant. When a customer arrives you could:
 *   A) Buy a new plate for every dish served (wasteful — garbage piles up)
 *   B) Wash and reuse plates from a rack (efficient — fixed inventory)
 *   AudioPool is option B. We pre-create N audio elements at startup and
 *   cycle through them for playback, never allocating new ones during gameplay.
 *
 * LIFECYCLE:
 *   Available pool  →  acquire()  →  Active set  →  (sound ends)  →  release()  →  Available pool
 *   ^^ ready to use                   ^^ playing                                  ^^ reset, waiting
 */
export class AudioPool {
  /** Audio elements that are idle and ready to play the next sound. */
  private available: HTMLAudioElement[] = [];

  /** Audio elements that are currently playing. */
  private active: HTMLAudioElement[] = [];

  /** Maximum number of audio elements in this pool. */
  private maxSize: number;

  /**
   * Pre-allocate the pool with maxSize audio elements.
   * The 'ended' event fires when playback completes — we use it to
   * automatically return the element to the available pool.
   *
   * WHY 'ended' LISTENER:
   *   We can't know in advance when a sound will finish (depends on its duration
   *   and whether it loops). The 'ended' event is the audio element's built-in
   *   notification that playback finished. Listening to it lets us recycle
   *   elements without polling every frame.
   *
   * @param maxSize Pool capacity (number of concurrent instances).
   */
  constructor(maxSize: number = 8) {
    this.maxSize = maxSize;

    for (let i = 0; i < maxSize; i++) {
      const audio = new Audio();
      // When this element's sound finishes, automatically return it to the pool.
      // Arrow function captures `audio` in a closure so we know WHICH element ended.
      audio.addEventListener("ended", () => this.release(audio));
      this.available.push(audio);
    }
  }

  /**
   * Get an idle audio element from the pool.
   * If the pool is exhausted (all elements are playing), creates a fresh one.
   * In normal gameplay this "overflow" case should be rare.
   *
   * @returns An HTMLAudioElement ready to have .src, .volume, etc. set.
   */
  public acquire(): HTMLAudioElement {
    let audio: HTMLAudioElement;

    if (this.available.length > 0) {
      // Reuse an idle element — pops from end for O(1) removal.
      audio = this.available.pop()!; // ! — we just checked length > 0, so it's defined
    } else {
      // Pool is fully occupied — create an overflow element.
      // This is the slow path and should be rare if maxSize is tuned correctly.
      audio = new Audio();
      audio.addEventListener("ended", () => this.release(audio));
    }

    this.active.push(audio); // Track as currently-playing
    return audio;
  }

  /**
   * Return an audio element to the pool after its sound finishes.
   * Resets all properties to defaults so the element is ready for reuse.
   *
   * IMPORTANT: We reset playbackRate and volume to 1 so leftover pitch/volume
   * settings from the previous sound don't bleed into the next one.
   *
   * @param audio The element to return.
   */
  public release(audio: HTMLAudioElement): void {
    // Remove from the active list (splice handles removal by index).
    const index = this.active.indexOf(audio); // O(n) but active list is tiny (< 8 elements)
    if (index > -1) {
      this.active.splice(index, 1); // Remove one element at this index
    }

    // Reset to clean neutral state.
    audio.pause();           // Stop if somehow still playing
    audio.currentTime = 0;  // Rewind to start for next use
    audio.volume = 1;        // Reset volume to default
    audio.playbackRate = 1;  // Reset pitch shift
    audio.loop = false;      // Remove loop setting

    // Return to available pool (if not over capacity).
    // If we created overflow elements, they eventually get GC'd when the pool
    // fills up with pre-allocated ones again.
    if (this.available.length < this.maxSize) {
      this.available.push(audio);
    }
    // If at capacity, the overflow element is simply abandoned (GC will reclaim it).
  }

  /**
   * Immediately stop all playing audio in this pool.
   * Used when resetting the simulation — stops engine thrust sounds instantly.
   */
  public stopAll(): void {
    for (const audio of this.active) {
      audio.pause();
      audio.currentTime = 0; // Rewind in case it's replayed
    }
    // Move all active elements back to available.
    this.available.push(...this.active); // Spread operator appends all elements
    this.active = []; // Clear active list
  }

  /**
   * How many elements are currently playing.
   * Used by AudioManager to check if the pool is saturated before acquiring.
   */
  public getActiveCount(): number {
    return this.active.length;
  }
}

// ─── OSCILLATOR SOUND ────────────────────────────────────────────────────────

/**
 * Generates procedural beep sounds using the Web Audio API's oscillator nodes.
 * No audio files required — we synthesize tones from mathematical waveforms.
 *
 * WEB AUDIO API GRAPH FOR A BEEP:
 *
 *   OscillatorNode (frequency=800 Hz, type=sine)
 *         ↓
 *   GainNode (volume=0.3, with exponential fade-out)
 *         ↓
 *   AudioContext.destination (the speakers)
 *
 * OSCILLATOR TYPES:
 *   "sine"     — Pure single frequency, smooth and pleasant (used for UI beeps)
 *   "square"   — Buzzy, rich harmonics, retro sound (good for warnings)
 *   "sawtooth" — Harsh, lots of harmonics (good for harsh alerts)
 *   "triangle" — Mellow, fewer harmonics than square (gentle alternative)
 *
 * GAIN ENVELOPE (volume over time):
 *   We use exponentialRampToValueAtTime to fade the volume from 0.3 down to 0.01
 *   over the duration. This prevents the harsh "click" you get when a square wave
 *   is suddenly cut off — the gradual fade sounds much more natural.
 *
 * AUDIO CONTEXT RULES:
 *   Browsers require a user gesture (click, keypress) before AudioContext can play.
 *   This prevents autoplay spam. Our sounds are triggered by player actions
 *   (SPACEBAR for thrust, clicks for buttons) so this requirement is always met.
 *   We store the context on window to reuse it — each page should have only one.
 */
export class OscillatorSound {
  /**
   * The Web Audio API context.
   * Represents the audio hardware connection and processing graph.
   * We use a single context for all oscillator sounds (shared on window).
   * Creating multiple contexts wastes resources; the spec recommends one per page.
   */
  private audioContext: AudioContext;

  constructor() {
    // Retrieve existing context from window if one was already created (avoids
    // creating multiple AudioContexts when OscillatorSound is instantiated more than once).
    // (window as any) bypasses TypeScript's strict type checking for this non-standard property.
    this.audioContext =
      (window as any).audioContext ||
      new (window.AudioContext || (window as any).webkitAudioContext)();
    //                               ^^^^ webkitAudioContext: Safari's prefixed name (older versions)

    // Store on window so subsequent OscillatorSound instances reuse this same context.
    (window as any).audioContext = this.audioContext;
  }

  /**
   * Play a single beep at a given frequency for a given duration.
   *
   * HOW THE AUDIO GRAPH IS BUILT:
   *   1. Create an OscillatorNode — generates a continuous sine wave at `frequency` Hz.
   *   2. Create a GainNode — controls volume (amplitude) of the signal.
   *   3. Connect: Oscillator → Gain → Destination (speakers).
   *   4. Schedule: start the oscillator at `now`, stop at `now + duration`.
   *   5. Fade: exponentialRamp reduces gain from `volume` to nearly 0 just before stop.
   *      This avoids the "click" artifact from an abrupt stop.
   *
   * WHY SCHEDULED TIMING (osc.start(now), osc.stop(now+duration))?
   *   The Web Audio API uses a high-resolution timestamp-based scheduler.
   *   Scheduling events via this system is more accurate than setTimeout() because:
   *   - setTimeout is subject to JS event loop delays (can be 10+ ms late)
   *   - Audio API scheduling runs in the audio thread, independent of JS
   *   This matters for music/rhythm games but is nice for any sound design.
   *
   * @param frequency  Frequency in Hz (pitch). 440 Hz = concert A, 800 Hz = high beep.
   * @param duration   How long the beep lasts in seconds.
   * @param volume     Peak volume 0–1 (0.3 is comfortable without being startling).
   */
  public playBeep(frequency: number = 800, duration: number = 0.2, volume: number = 0.3): void {
    try {
      // currentTime: the audio clock's current position in seconds.
      // All scheduled events use this timeline (not wall clock / Date.now()).
      const now = this.audioContext.currentTime;

      // Create the tone generator.
      const osc = this.audioContext.createOscillator();
      osc.frequency.value = frequency; // Set pitch (Hz)
      osc.type = "sine";               // Smooth sine wave for pleasant UI sounds

      // Create the volume controller.
      const gainNode = this.audioContext.createGain();

      // SET initial gain at time `now` — required before ramp.
      // Without this anchor, the ramp has no starting value to ramp FROM.
      gainNode.gain.setValueAtTime(volume, now);

      // RAMP gain DOWN to nearly 0 by end of duration.
      // exponentialRampToValueAtTime: smooth, natural-sounding fade.
      // Note: we can't ramp to exactly 0 (exponential approaches but never reaches 0),
      // so we ramp to 0.01 which is inaudible (< 1% of the signal).
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration);

      // Build the graph: Oscillator → Gain → Speakers.
      osc.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      // Schedule playback: start now, stop after duration seconds.
      osc.start(now);
      osc.stop(now + duration);
      // After osc.stop() fires, the OscillatorNode automatically disconnects itself.
      // No manual cleanup needed — the graph nodes are garbage collected.

    } catch (e) {
      // AudioContext can fail if the browser blocks audio (permissions, privacy mode).
      // We silently continue — missing sound effects are not fatal.
      console.error("Oscillator error:", e);
    }
  }

  /**
   * Play a two-tone rising chime (used for UI selection confirmation).
   * Two beeps in quick succession with rising pitch signals "confirmation" to the user.
   * This is a common UX pattern in video game menus.
   *
   * Frequencies: 600 Hz → 800 Hz (ascending = positive feedback)
   * Timing:      0ms, then 100ms delay (short enough to feel like one event)
   */
  public playSelectBeep(): void {
    this.playBeep(600, 0.1); // Low tone first (600 Hz)
    // Schedule high tone 100 ms later using setTimeout.
    // setTimeout is fine here (vs audio scheduling) because 100 ms tolerance is acceptable.
    setTimeout(() => this.playBeep(800, 0.1), 100); // High tone follows (800 Hz)
  }

  /**
   * Play the three-beep warning pattern used in aerospace systems.
   * Three rapid beeps (like a car alarm or a fire alarm: beep-beep-beep).
   * This pattern is universally recognized as "something requires attention."
   *
   * 500 Hz is in the 400–800 Hz "warning frequency" range — audible at distance,
   * not painfully high, cuts through ambient noise.
   */
  public playWarningBeep(): void {
    // Schedule 3 beeps: at 0ms, 150ms, and 300ms offsets.
    // i * 150ms spacing gives a quick "dah-dah-dah" pattern.
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.playBeep(500, 0.1), i * 150);
    }
    // Total warning pattern duration: ~450 ms (3 × 150 ms) — short and alerting.
  }
}

// ─── AUDIO MANAGER ────────────────────────────────────────────────────────────

/**
 * AudioManager is the public API for all sound playback.
 *
 * It abstracts over two sound backends:
 *   1. Pool-based HTMLAudioElement playback (for loaded audio files)
 *   2. Oscillator-based procedural synthesis (for beeps with no files)
 *
 * VOLUME CHAIN (layered volume system):
 *   Each sound's final volume = masterVolume × categoryVolume × soundVolume × optionalOverride
 *
 *   masterVolume = 0.5   (player's master slider: 0 = mute, 1 = full)
 *   categoryVolume:
 *     "engine" = 0.7    (engine sounds slightly quieter than explosions)
 *     "explosion" = 0.8  (loud booms)
 *     "ui" = 0.6        (UI feedback is softer than gameplay sounds)
 *     "warning" = 0.9   (warnings must be heard)
 *   soundVolume = per-SoundConfig value (0.4–0.9)
 *
 *   Example: master=0.5 × engine=0.7 × sound=0.7 = 0.245 final volume
 *   This layered system lets the player control volume globally without
 *   breaking the relative loudness between different sound types.
 *
 * MUTE HANDLING:
 *   isMuted=true → playSound() returns immediately without playing anything.
 *   stopAllSounds() is also called so loops (engine thrust) stop on mute.
 *   Re-unmuting doesn't automatically restart loops — the player must throttle
 *   again, which re-triggers playSound("engine-thrust") naturally.
 */
export class AudioManager {
  /** Audio pools, one per sound type — reuse elements instead of allocating new ones. */
  private pools: Map<SoundEffect, AudioPool> = new Map();

  /** Configuration for each registered sound effect. */
  private configs: Map<SoundEffect, SoundConfig> = new Map();

  /** Oscillator for procedural beep sounds (UI clicks, warnings, etc.). */
  private oscillator: OscillatorSound;

  /**
   * Global volume scale 0–1.
   * Multiplied into every played sound's volume.
   * Changed by the player's master volume slider in the top bar.
   */
  private masterVolume: number = 0.5;

  /**
   * Per-category volume scales.
   * Allow independent loudness adjustment of each group.
   * Stored in a Map for O(1) lookup by category string.
   */
  private categoryVolumes: Map<string, number> = new Map([
    ["engine",      0.7], // Engine sounds: slightly softer than explosions
    ["explosion",   0.8], // Loud impacts and separation events
    ["ui",          0.6], // UI feedback: subtle background sounds
    ["environment", 0.5], // Ambient sounds: wind, parachute
    ["warning",     0.9], // Warnings: loud enough to always be heard over gameplay
  ]);

  /** When true, playSound() returns immediately without playing. */
  private isMuted: boolean = false;

  /**
   * Reference to the currently active looping engine sound element.
   * Stored so we can stop the previous one before starting a new pitch.
   * Without this reference, old engine sounds would play over new ones.
   */
  private activeEngineSound: HTMLAudioElement | null = null;

  constructor() {
    // Create the oscillator for procedural sounds (beeps don't need audio files).
    this.oscillator = new OscillatorSound();

    // Register all built-in sound effects with their configurations.
    this.registerDefaultSounds();
  }

  /**
   * Register all built-in sound effects.
   * Called once in the constructor. Each sound gets:
   *   1. A SoundConfig entry (volume, pitch, category, loop settings)
   *   2. An AudioPool of the appropriate size
   *
   * Sounds with empty `source` strings use the OscillatorSound instead —
   * no audio file loading required for those.
   */
  private registerDefaultSounds(): void {
    // ── ENGINE SOUNDS ──────────────────────────────────────────────────────────

    // One-shot ignition pop (single fire when engine first ignites from zero throttle)
    this.registerSound("engine-ignition", {
      source: "",            // Empty = procedural oscillator sound
      loop: false,           // Single fire
      volume: 0.8,           // Audible but not startling
      pitchVariation: false, // No pitch variation for ignition
      pitchMin: 1,
      pitchMax: 1,
      category: "engine",
      maxInstances: 1,       // Only one ignition sound at a time
    });

    // Continuous engine roar while thrusting (loops the entire time)
    this.registerSound("engine-thrust", {
      source: "",            // Procedural
      loop: true,            // LOOP: plays continuously while engine is burning
      volume: 0.7,
      pitchVariation: true,  // Pitch varies with throttle level (0.8–1.2× shift)
      pitchMin: 0.8,         // At low throttle: lower pitch (bigger, heavier sound)
      pitchMax: 1.2,         // At full throttle: higher pitch (more energetic)
      category: "engine",
      maxInstances: 1,       // Only ever one engine loop at a time
    });

    // ── EVENTS ────────────────────────────────────────────────────────────────

    // Explosive crack when stage pyrotechnics fire and the stage separates
    this.registerSound("stage-separation", {
      source: "",
      loop: false,
      volume: 0.9,           // Loud! Stage separation is dramatic
      pitchVariation: true,  // Slight variation so repeated separations aren't identical
      pitchMin: 0.9,
      pitchMax: 1.1,
      category: "explosion",
      maxInstances: 3,       // Allow up to 3 simultaneous (unlikely but safe)
    });

    // Whoosh as parachute canopy catches air and rapidly fills
    this.registerSound("parachute-deploy", {
      source: "",
      loop: false,
      volume: 0.6,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "environment",
      maxInstances: 1,       // Only one parachute deploy at a time
    });

    // ── LANDING SOUNDS ─────────────────────────────────────────────────────────

    // Soft landing: gentle thump, slight structural creak
    this.registerSound("landing-soft", {
      source: "",
      loop: false,
      volume: 0.5,           // Quiet — it's a soft landing after all
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "explosion",  // Categorized under explosion (impact group)
      maxInstances: 1,
    });

    // Hard landing or crash: metallic crash, structural failure sounds
    this.registerSound("landing-hard", {
      source: "",
      loop: false,
      volume: 0.9,           // Very loud — signal this is a bad outcome
      pitchVariation: true,  // Pitch variation for variety
      pitchMin: 0.7,         // Lower pitch = heavier impact
      pitchMax: 0.9,
      category: "explosion",
      maxInstances: 1,
    });

    // ── UI SOUNDS ──────────────────────────────────────────────────────────────

    // Button click confirmation
    this.registerSound("ui-click", {
      source: "",             // Oscillator beep
      loop: false,
      volume: 0.4,            // Quiet — UI sounds should not compete with gameplay
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "ui",
      maxInstances: 4,        // Rapid clicking: allow overlapping sounds
    });

    // Dropdown/select change: two-tone ascending chime
    this.registerSound("ui-select", {
      source: "",             // Oscillator select beep
      loop: false,
      volume: 0.4,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "ui",
      maxInstances: 2,
    });

    // ── WARNING SOUNDS ─────────────────────────────────────────────────────────

    // Three-beep alert for engine failures, structural damage, overheating
    this.registerSound("warning-beep", {
      source: "",             // Oscillator warning pattern
      loop: false,
      volume: 0.6,            // Noticeable but not deafening
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "warning",
      maxInstances: 3,        // Warnings can stack (multiple failures at once)
    });

    // ── THROTTLE FEEDBACK ──────────────────────────────────────────────────────

    // Audio cue when throttle ramps up by a significant amount
    this.registerSound("thrust-increase", {
      source: "",
      loop: false,
      volume: 0.5,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "engine",
      maxInstances: 2,
    });

    // Audio cue when throttle drops by a significant amount
    this.registerSound("thrust-decrease", {
      source: "",
      loop: false,
      volume: 0.5,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "engine",
      maxInstances: 2,
    });
  }

  /**
   * Register a sound effect with its configuration and allocate a pool for it.
   * Can be called externally to add custom sounds at runtime.
   *
   * @param effect  Sound identifier.
   * @param config  Full configuration for this sound.
   */
  public registerSound(effect: SoundEffect, config: SoundConfig): void {
    this.configs.set(effect, config); // Store configuration

    // Pool size is maxInstances, but we special-case some sounds.
    let poolSize = config.maxInstances;
    if (effect === "engine-thrust") poolSize = 1; // Only ever one engine loop
    if (effect === "ui-click") poolSize = 4;      // Allow rapid-click stacking

    this.pools.set(effect, new AudioPool(poolSize));
  }

  /**
   * Play a sound effect, handling file-based and procedural sounds transparently.
   *
   * VOLUME CALCULATION:
   *   finalVolume = masterVolume × categoryVolume × configVolume × optionalOverride
   *
   * PITCH CALCULATION:
   *   If pitchVariation is enabled and no override provided:
   *     pitch = random between [pitchMin, pitchMax]
   *   Otherwise: pitch = override or 1.0 (no shift)
   *
   * @param effect   Which sound to play.
   * @param options  Optional volume/pitch/loop overrides for this specific play.
   */
  public playSound(
    effect: SoundEffect,
    options: {
      volume?: number;  // Override this play's volume (multiplied into final volume)
      pitch?: number;   // Override this play's pitch (1.0 = no shift, 2.0 = one octave up)
      loop?: boolean;   // Override this play's loop setting
    } = {} // Default to empty options object so callers can omit it
  ): void {
    // Respect the global mute state — return immediately if muted.
    if (this.isMuted) return;

    const config = this.configs.get(effect); // Look up sound configuration
    if (!config) {
      console.warn(`Sound effect not registered: ${effect}`);
      return;
    }

    // Sounds without audio files (source="" ) use the oscillator instead.
    if (!config.source || config.source === "") {
      this.playProceduralSound(effect); // Generate tone mathematically
      return; // Done — no further audio element work needed
    }

    try {
      const pool = this.pools.get(effect);
      if (!pool) return;

      // Acquire an idle audio element from the pool.
      const audio = pool.acquire();

      // Set the audio file source.
      audio.src = config.source;

      // Calculate final volume: multiply all three layers together.
      const categoryVolume = this.categoryVolumes.get(config.category) || 1;
      const finalVolume = this.masterVolume
        * categoryVolume
        * (options.volume ?? config.volume); // ?? = use config default if no override
      // Clamp to [0, 1] to prevent browser errors from out-of-range volume.
      audio.volume = Math.max(0, Math.min(1, finalVolume));

      // Apply pitch shift — either random variation or explicit override.
      if (config.pitchVariation) {
        // Random pitch in [pitchMin, pitchMax] range.
        // Math.random() returns [0, 1); scaling to [min, max]: min + rand*(max-min).
        const pitch = options.pitch ??
          (Math.random() * (config.pitchMax - config.pitchMin) + config.pitchMin);
        audio.playbackRate = pitch;
      } else {
        // Use explicit override or 1.0 (unshifted).
        audio.playbackRate = options.pitch ?? 1;
      }

      // Apply loop setting (override takes priority over config default).
      audio.loop = options.loop ?? config.loop;

      // Special engine sound handling: stop the old loop before starting a new one.
      // This prevents multiple overlapping engine drones when throttle pitch changes.
      if (effect === "engine-thrust") {
        if (this.activeEngineSound && this.activeEngineSound !== audio) {
          this.activeEngineSound.pause();
          this.activeEngineSound.currentTime = 0;
        }
        this.activeEngineSound = audio; // Track the new active engine sound
      }

      // Start playback from the beginning.
      audio.currentTime = 0;
      // .play() returns a Promise that resolves when playback starts.
      // We catch rejection because browsers can prevent autoplay in some contexts.
      audio.play().catch(() => {
        // Autoplay policy blocked the sound — silently ignore.
        // This happens if the user hasn't interacted with the page yet.
      });

    } catch (e) {
      // Catch any other audio errors (device not available, codec unsupported, etc.)
      console.error(`Error playing sound ${effect}:`, e);
    }
  }

  /**
   * Handle sounds that use the oscillator instead of audio files.
   * Maps each SoundEffect to its appropriate oscillator pattern.
   *
   * @param effect Which sound effect to generate procedurally.
   */
  private playProceduralSound(effect: SoundEffect): void {
    // Scale oscillator volume by master × category volumes.
    const volume = (this.categoryVolumes.get("ui") || 1) * this.masterVolume;

    switch (effect) {
      case "ui-click":
        // Short low-pitched click: 600 Hz for 0.1 seconds
        this.oscillator.playBeep(600, 0.1, volume * 0.3);
        break;
      case "ui-select":
        // Two-tone rising chime: 600 Hz then 800 Hz
        this.oscillator.playSelectBeep();
        break;
      case "warning-beep":
        // Triple-beep alert pattern at 500 Hz
        this.oscillator.playWarningBeep();
        break;
      case "engine-ignition":
        // Short mid-frequency pop to simulate ignition
        this.oscillator.playBeep(300, 0.15, volume * 0.4);
        break;
      case "thrust-increase":
        // Rising tone: signal power increasing
        this.oscillator.playBeep(400, 0.08, volume * 0.25);
        break;
      case "thrust-decrease":
        // Falling tone: signal power decreasing (slightly lower frequency)
        this.oscillator.playBeep(350, 0.08, volume * 0.25);
        break;
      case "landing-soft":
        // Low thud for soft landing
        this.oscillator.playBeep(150, 0.2, volume * 0.5);
        break;
      case "landing-hard":
        // Low rumble for hard landing/crash
        this.oscillator.playBeep(80, 0.4, volume * 0.8);
        break;
      case "stage-separation":
        // Short sharp high-frequency pop
        this.oscillator.playBeep(700, 0.12, volume * 0.6);
        break;
      case "parachute-deploy":
        // Whoosh-like rising sweep (simulated with a medium tone)
        this.oscillator.playBeep(450, 0.25, volume * 0.4);
        break;
      default:
        // Fallback: generic beep for any unhandled sound
        this.oscillator.playBeep(400, 0.15, volume * 0.3);
    }
  }

  /**
   * Stop a specific looping sound.
   * Used to stop "engine-thrust" when throttle reaches zero.
   *
   * @param effect The sound to stop.
   */
  public stopSound(effect: SoundEffect): void {
    const pool = this.pools.get(effect);
    if (!pool) return;

    // Special handling for the engine loop: stop and release the tracked reference.
    if (effect === "engine-thrust" && this.activeEngineSound) {
      this.activeEngineSound.pause();
      this.activeEngineSound.currentTime = 0;
      this.activeEngineSound = null; // Clear reference so next playSound starts fresh
    }
  }

  /**
   * Immediately stop every sound across all pools.
   * Called on Reset so silence is instant — no sounds carry over from the old flight.
   */
  public stopAllSounds(): void {
    for (const pool of this.pools.values()) {
      pool.stopAll(); // Each pool stops and recycles its active elements
    }
    this.activeEngineSound = null; // Clear the engine loop reference
  }

  /** Set the master volume (0 = silent, 1 = full). Clamped to [0, 1]. */
  public setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume)); // Clamp
  }

  /** Get the current master volume (used to restore slider position on re-mount). */
  public getMasterVolume(): number {
    return this.masterVolume;
  }

  /** Override volume for an entire category (e.g., reduce engine sounds independently). */
  public setCategoryVolume(category: string, volume: number): void {
    this.categoryVolumes.set(category, Math.max(0, Math.min(1, volume)));
  }

  /** Get a category's current volume multiplier. */
  public getCategoryVolume(category: string): number {
    return this.categoryVolumes.get(category) || 1;
  }

  /** Mute all audio and stop currently playing sounds. */
  public mute(): void {
    this.isMuted = true;
    this.stopAllSounds(); // Stop loops immediately rather than letting them play out
  }

  /** Re-enable audio playback. Does NOT restart any previously stopped loops. */
  public unmute(): void {
    this.isMuted = false;
  }

  /**
   * Toggle mute state and return the new state.
   * Convenient for a single button that acts as mute/unmute toggle.
   *
   * @returns true if now muted, false if now unmuted.
   */
  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this.stopAllSounds(); // Ensure loops stop immediately on mute
    }
    return this.isMuted; // Return new state for UI button to reflect
  }

  /** Is audio currently muted? (For UI checkbox/button display.) */
  public getMuted(): boolean {
    return this.isMuted;
  }

  /**
   * Load a real audio file URL for a sound effect.
   * Can be called after construction to upgrade from oscillator to file-based audio.
   *
   * @param effect The sound to configure with a real file.
   * @param url    URL to the audio file (MP3, OGG, WAV).
   */
  public setAudioSource(effect: SoundEffect, url: string): void {
    const config = this.configs.get(effect);
    if (config) {
      config.source = url; // Update the source URL
      // Next call to playSound() will use this URL instead of the oscillator
    }
  }
}
