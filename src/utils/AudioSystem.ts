/**
 * ROCKET SIMULATOR - AUDIO SYSTEM
 * ===============================
 * Complete audio management system for sound effects in the rocket simulator.
 * 
 * Features:
 * - Sound effect pooling (reuse audio elements for better performance)
 * - Master volume control
 * - Individual sound volume control
 * - Pitch variation for realistic effects
 * - Looping sound support (for engine thrust)
 * - Sound categories (engine, explosion, ui, etc.)
 * - Mute/unmute functionality
 * - Audio context management (Web Audio API)
 */

/**
 * Sound effect type definitions
 * Each sound has specific characteristics for realistic audio
 */
export type SoundEffect = 
  | "engine-ignition"    // Engine starting up (one-shot)
  | "engine-thrust"      // Continuous engine sound (looping)
  | "stage-separation"   // Stage separates (explosion sound)
  | "parachute-deploy"   // Parachute deploys (whoosh)
  | "landing-soft"       // Soft landing (gentle impact)
  | "landing-hard"       // Hard landing (crash sound)
  | "ui-click"           // Button click
  | "ui-select"          // Selection/dropdown change
  | "warning-beep"       // Low fuel warning
  | "thrust-increase"    // Throttle up
  | "thrust-decrease";   // Throttle down

/**
 * Sound configuration for each effect
 * Defines how the sound should be played
 */
export interface SoundConfig {
  // URL or data URL to audio file
  source: string;

  // Should this sound loop?
  loop: boolean;

  // Default volume (0-1)
  volume: number;

  // Can pitch be varied? (for engine sounds, explosions)
  pitchVariation: boolean;

  // Minimum pitch multiplier (1 = normal pitch)
  pitchMin: number;

  // Maximum pitch multiplier
  pitchMax: number;

  // Category for grouping (engine, ui, explosions)
  category: "engine" | "explosion" | "ui" | "environment" | "warning";

  // Maximum concurrent instances of this sound
  maxInstances: number;
}

/**
 * Audio pool for managing sound playback
 * Reuses audio elements instead of creating new ones
 */
export class AudioPool {
  // Array of available audio elements
  private available: HTMLAudioElement[] = [];

  // Array of currently-playing audio elements
  private active: HTMLAudioElement[] = [];

  // Maximum size of pool
  private maxSize: number;

  /**
   * Create an audio pool with specified capacity
   */
  constructor(maxSize: number = 8) {
    this.maxSize = maxSize;

    // Pre-allocate audio elements
    for (let i = 0; i < maxSize; i++) {
      const audio = new Audio();
      audio.addEventListener("ended", () => this.release(audio));
      this.available.push(audio);
    }
  }

  /**
   * Get an audio element from the pool
   * Either reuses one or creates new if pool exhausted
   */
  public acquire(): HTMLAudioElement {
    let audio: HTMLAudioElement;

    if (this.available.length > 0) {
      // Reuse from pool
      audio = this.available.pop()!;
    } else {
      // Create new if pool is full
      audio = new Audio();
      audio.addEventListener("ended", () => this.release(audio));
    }

    // Track as active
    this.active.push(audio);
    return audio;
  }

  /**
   * Return an audio element to the pool
   */
  public release(audio: HTMLAudioElement): void {
    // Remove from active list
    const index = this.active.indexOf(audio);
    if (index > -1) {
      this.active.splice(index, 1);
    }

    // Reset audio state
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    audio.playbackRate = 1;
    audio.loop = false;

    // Return to pool if not full
    if (this.available.length < this.maxSize) {
      this.available.push(audio);
    }
  }

  /**
   * Stop all active sounds immediately
   */
  public stopAll(): void {
    for (const audio of this.active) {
      audio.pause();
      audio.currentTime = 0;
    }

    this.available.push(...this.active);
    this.active = [];
  }

  /**
   * Get count of active sounds
   */
  public getActiveCount(): number {
    return this.active.length;
  }
}

/**
 * Web Audio API oscillator for simple beep sounds
 * Used for UI clicks and warning beeps (no audio file needed)
 */
export class OscillatorSound {
  private audioContext: AudioContext;

  /**
   * Create oscillator sound generator
   */
  constructor() {
    // Create audio context (shared across all oscillator sounds)
    this.audioContext =
      (window as any).audioContext ||
      new (window.AudioContext || (window as any).webkitAudioContext)();

    // Store globally so we can reuse it
    (window as any).audioContext = this.audioContext;
  }

  /**
   * Play a simple beep sound
   */
  public playBeep(frequency: number = 800, duration: number = 0.2, volume: number = 0.3): void {
    try {
      const now = this.audioContext.currentTime;

      // Create oscillator (tone generator)
      const osc = this.audioContext.createOscillator();
      osc.frequency.value = frequency;
      osc.type = "sine"; // Smooth sine wave

      // Create gain node (for volume and envelope)
      const gainNode = this.audioContext.createGain();
      gainNode.gain.setValueAtTime(volume, now);
      gainNode.gain.exponentialRampToValueAtTime(0.01, now + duration); // Fade out

      // Connect and play
      osc.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      osc.start(now);
      osc.stop(now + duration);
    } catch (e) {
      // Audio context might not be initialized, silently fail
      console.error("Oscillator error:", e);
    }
  }

  /**
   * Play ascending beep (for selection)
   */
  public playSelectBeep(): void {
    this.playBeep(600, 0.1);
    setTimeout(() => this.playBeep(800, 0.1), 100);
  }

  /**
   * Play warning beep (rapid repeating)
   */
  public playWarningBeep(): void {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this.playBeep(500, 0.1), i * 150);
    }
  }
}

/**
 * Main Audio Manager
 * Manages all sound effects, volume, and playback
 */
export class AudioManager {
  // Audio pools for different sound types
  private pools: Map<SoundEffect, AudioPool> = new Map();

  // Sound configurations
  private configs: Map<SoundEffect, SoundConfig> = new Map();

  // Oscillator for procedural sounds (beeps)
  private oscillator: OscillatorSound;

  // Master volume (0-1)
  private masterVolume: number = 0.5;

  // Category volumes
  private categoryVolumes: Map<string, number> = new Map([
    ["engine", 0.7],
    ["explosion", 0.8],
    ["ui", 0.6],
    ["environment", 0.5],
    ["warning", 0.9],
  ]);

  // Is audio muted?
  private isMuted: boolean = false;

  // Currently active engine sound (for looping/stopping)
  private activeEngineSound: HTMLAudioElement | null = null;

  /**
   * Create audio manager and register sound effects
   */
  constructor() {
    this.oscillator = new OscillatorSound();

    // Initialize default sound configurations
    this.registerDefaultSounds();
  }

  /**
   * Register default rocket sounds with configurations
   * These map to sound effects that will be created
   */
  private registerDefaultSounds(): void {
    // Engine sounds
    this.registerSound("engine-ignition", {
      source: "", // Will be set to actual audio file URL
      loop: false,
      volume: 0.8,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "engine",
      maxInstances: 1,
    });

    this.registerSound("engine-thrust", {
      source: "",
      loop: true, // Looping engine sound
      volume: 0.7,
      pitchVariation: true, // Pitch varies with throttle
      pitchMin: 0.8,
      pitchMax: 1.2,
      category: "engine",
      maxInstances: 1,
    });

    // Explosion sounds
    this.registerSound("stage-separation", {
      source: "",
      loop: false,
      volume: 0.9,
      pitchVariation: true,
      pitchMin: 0.9,
      pitchMax: 1.1,
      category: "explosion",
      maxInstances: 3,
    });

    this.registerSound("parachute-deploy", {
      source: "",
      loop: false,
      volume: 0.6,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "environment",
      maxInstances: 1,
    });

    // Landing sounds
    this.registerSound("landing-soft", {
      source: "",
      loop: false,
      volume: 0.5,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "explosion",
      maxInstances: 1,
    });

    this.registerSound("landing-hard", {
      source: "",
      loop: false,
      volume: 0.9,
      pitchVariation: true,
      pitchMin: 0.7,
      pitchMax: 0.9,
      category: "explosion",
      maxInstances: 1,
    });

    // UI sounds
    this.registerSound("ui-click", {
      source: "", // Will use oscillator
      loop: false,
      volume: 0.4,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "ui",
      maxInstances: 4,
    });

    this.registerSound("ui-select", {
      source: "", // Will use oscillator
      loop: false,
      volume: 0.4,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "ui",
      maxInstances: 2,
    });

    // Warning sounds
    this.registerSound("warning-beep", {
      source: "", // Will use oscillator
      loop: false,
      volume: 0.6,
      pitchVariation: false,
      pitchMin: 1,
      pitchMax: 1,
      category: "warning",
      maxInstances: 3,
    });

    // Throttle sounds
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
   * Register a custom sound effect
   */
  public registerSound(effect: SoundEffect, config: SoundConfig): void {
    this.configs.set(effect, config);

    // Create audio pool for this sound
    // Larger pool for commonly used sounds
    let poolSize = config.maxInstances;
    if (effect === "engine-thrust") poolSize = 1;
    if (effect === "ui-click") poolSize = 4;

    this.pools.set(effect, new AudioPool(poolSize));
  }

  /**
   * Play a sound effect
   * Handles audio pooling, pitch variation, and volume
   */
  public playSound(
    effect: SoundEffect,
    options: {
      volume?: number;
      pitch?: number;
      loop?: boolean;
    } = {}
  ): void {
    // Don't play if muted
    if (this.isMuted) return;

    const config = this.configs.get(effect);
    if (!config) {
      console.warn(`Sound effect not registered: ${effect}`);
      return;
    }

    // Special handling for procedural sounds (no audio file)
    if (!config.source || config.source === "") {
      this.playProceduralSound(effect);
      return;
    }

    try {
      // Get audio element from pool
      const pool = this.pools.get(effect);
      if (!pool) return;

      const audio = pool.acquire();

      // Set audio source
      audio.src = config.source;

      // Calculate final volume
      // Master volume × category volume × sound volume × optional override
      const categoryVolume = this.categoryVolumes.get(config.category) || 1;
      const finalVolume = this.masterVolume * categoryVolume * (options.volume ?? config.volume);
      audio.volume = Math.max(0, Math.min(1, finalVolume));

      // Apply pitch variation if enabled
      if (config.pitchVariation) {
        const pitch = options.pitch ??
          (Math.random() * (config.pitchMax - config.pitchMin) + config.pitchMin);
        audio.playbackRate = pitch;
      } else {
        audio.playbackRate = options.pitch ?? 1;
      }

      // Set looping
      audio.loop = options.loop ?? config.loop;

      // Special handling for engine sound (stop previous one)
      if (effect === "engine-thrust") {
        if (this.activeEngineSound && this.activeEngineSound !== audio) {
          this.activeEngineSound.pause();
          this.activeEngineSound.currentTime = 0;
        }
        this.activeEngineSound = audio;
      }

      // Play the sound
      audio.currentTime = 0;
      audio.play().catch(() => {
        // Audio playback might fail on some browsers, silently handle
      });
    } catch (e) {
      console.error(`Error playing sound ${effect}:`, e);
    }
  }

  /**
   * Play procedural sound (oscillator-based, no audio file needed)
   * Used for UI clicks and warning beeps
   */
  private playProceduralSound(effect: SoundEffect): void {
    const volume = (this.categoryVolumes.get("ui") || 1) * this.masterVolume;

    switch (effect) {
      case "ui-click":
        this.oscillator.playBeep(600, 0.1, volume * 0.3);
        break;
      case "ui-select":
        this.oscillator.playSelectBeep();
        break;
      case "warning-beep":
        this.oscillator.playWarningBeep();
        break;
      default:
        // Default beep for unknown procedural sounds
        this.oscillator.playBeep(400, 0.15, volume * 0.3);
    }
  }

  /**
   * Stop a specific looping sound
   * Used to stop engine sounds when throttle reaches zero
   */
  public stopSound(effect: SoundEffect): void {
    const pool = this.pools.get(effect);
    if (!pool) return;

    if (effect === "engine-thrust" && this.activeEngineSound) {
      this.activeEngineSound.pause();
      this.activeEngineSound.currentTime = 0;
      this.activeEngineSound = null;
    }
  }

  /**
   * Stop all sounds immediately
   * Used when resetting flight or switching rockets
   */
  public stopAllSounds(): void {
    for (const pool of this.pools.values()) {
      pool.stopAll();
    }
    this.activeEngineSound = null;
  }

  /**
   * Set master volume (0-1)
   */
  public setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
  }

  /**
   * Get current master volume
   */
  public getMasterVolume(): number {
    return this.masterVolume;
  }

  /**
   * Set category volume (e.g., "engine", "ui", "explosion")
   */
  public setCategoryVolume(category: string, volume: number): void {
    this.categoryVolumes.set(category, Math.max(0, Math.min(1, volume)));
  }

  /**
   * Get category volume
   */
  public getCategoryVolume(category: string): number {
    return this.categoryVolumes.get(category) || 1;
  }

  /**
   * Mute all audio
   */
  public mute(): void {
    this.isMuted = true;
    this.stopAllSounds();
  }

  /**
   * Unmute audio
   */
  public unmute(): void {
    this.isMuted = false;
  }

  /**
   * Toggle mute state
   */
  public toggleMute(): boolean {
    this.isMuted = !this.isMuted;
    if (this.isMuted) {
      this.stopAllSounds();
    }
    return this.isMuted;
  }

  /**
   * Is audio muted?
   */
  public getMuted(): boolean {
    return this.isMuted;
  }

  /**
   * Load audio file URL for a sound effect
   * Can be called to load actual audio files
   */
  public setAudioSource(effect: SoundEffect, url: string): void {
    const config = this.configs.get(effect);
    if (config) {
      config.source = url;
    }
  }
}