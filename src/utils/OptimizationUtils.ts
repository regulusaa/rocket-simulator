/**
 * ROCKET SIMULATOR — OPTIMIZATION UTILITIES
 * ==========================================
 * Low-level performance helpers that reduce garbage collection pressure
 * and memory allocation costs in the hot paths of the game loop.
 *
 * WHY OPTIMIZATION MATTERS IN JAVASCRIPT:
 *   JavaScript uses automatic garbage collection (GC). When you create
 *   an object with `{}` or `new Foo()`, the JS engine allocates heap memory.
 *   When nothing references that object anymore, the GC eventually reclaims it.
 *
 *   The problem: GC doesn't run on your schedule. It can pause execution
 *   for 1-10ms — right in the middle of your frame loop. On a 16ms budget,
 *   a 5ms GC pause means you miss the frame deadline and the user sees a stutter.
 *
 *   Solution: allocate objects once, reuse them forever. The GC never needs
 *   to clean up objects that never get dereferenced.
 *
 * WHAT'S IN THIS FILE:
 *   ObjectPool<T>        — Generic "borrow, use, return" pool for any object type.
 *   CircularBuffer<T>    — Fixed-size ring buffer: push without ever allocating.
 *   ComputeCache<K,V>    — Memoize expensive function calls with time-based expiry.
 *   BatchProcessor<T>    — Spread a large array of work across multiple frames.
 *   TrajectoryPointPool  — Specialized pool for {x, y} trajectory points.
 *   approximately()      — Floating-point equality with tolerance.
 *   clamp()              — Restrict a value to [min, max].
 *   lerp()               — Linear interpolation between two values.
 *   easeOut() / easeIn() — Quadratic easing for smooth animations.
 */

// ─────────────────────────────────────────────────────────────────────────────
// OBJECT POOL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic object pool — borrow, use, return.
 *
 * ANALOGY: A library book. Instead of printing (allocating) a new book every
 * time someone wants to read, you keep a shelf (pool) of books. A borrower
 * takes one, reads it, then returns it for the next person. No printing (GC).
 *
 * HOW IT WORKS:
 *   - `available[]`: shelf of ready-to-use objects.
 *   - `inUse[]`: objects currently checked out.
 *   - acquire(): take from shelf (or print new if shelf is empty).
 *   - release(obj): return to shelf (reset first so next user gets a clean copy).
 *
 * FACTORY + RESET PATTERN:
 *   The factory function is called only when the pool is empty — it creates a
 *   brand-new object. The reset function puts an already-used object back to
 *   its initial state so it looks like new when someone borrows it again.
 *   Keeping them separate lets us construct once and reset many times,
 *   which is much faster than constructing from scratch each time.
 *
 * GENERIC TYPE PARAMETER <T>:
 *   T can be any type. ObjectPool<Particle> pools Particle objects.
 *   ObjectPool<AudioBuffer> pools audio buffers. Same code, different objects.
 *   TypeScript enforces that acquire() returns T and release() accepts T.
 *
 * @template T The type of object being pooled.
 */
export class ObjectPool<T> {
  // Objects ready to be borrowed — popped off in acquire()
  private available: T[] = [];

  // Objects currently in use — tracked so releaseAll() can return them
  private inUse: T[] = [];

  // Creates a fresh object when the pool runs dry
  private factory: () => T;

  // Resets an object to its initial state before returning it to the pool
  private reset: (obj: T) => void;

  /**
   * @param factory     Function that creates a new T.
   * @param reset       Function that clears a T back to clean state.
   * @param initialSize Pre-allocate this many objects at construction time.
   *                    This prevents any allocation at runtime if usage stays
   *                    below this number. Default 100 is fine for particles.
   */
  constructor(factory: () => T, reset: (obj: T) => void, initialSize: number = 100) {
    this.factory = factory;
    this.reset = reset;

    // Fill the pool up front so the first `initialSize` acquire() calls
    // are "free" — no allocation, just an array pop (O(1)).
    for (let i = 0; i < initialSize; i++) {
      this.available.push(factory());
    }
  }

  /**
   * Borrow an object from the pool.
   *
   * PERFORMANCE NOTE:
   *   Array.pop() is O(1) — it removes the last element without shifting.
   *   This is much faster than Array.shift() which is O(n) because it
   *   has to slide every remaining element one position to the left.
   *   We use pop() here and push() for returns — both O(1).
   *
   * @returns A T ready to use, either reused from pool or freshly created.
   */
  public acquire(): T {
    let obj: T;

    if (this.available.length > 0) {
      // Pool has stock — reuse without allocating
      obj = this.available.pop()!;
    } else {
      // Pool is exhausted — have to allocate a new one
      // This is rare if initialSize was set well; the GC hit is isolated here
      obj = this.factory();
    }

    this.inUse.push(obj);
    return obj;
  }

  /**
   * Return a borrowed object back to the pool.
   *
   * After release(), the caller MUST NOT keep any reference to `obj`.
   * The next acquire() may hand out the same object to a different caller —
   * if you kept a reference you'd silently be sharing state with them.
   *
   * @param obj The previously acquired object to return.
   */
  public release(obj: T): void {
    // Remove from the "in use" tracking list
    const index = this.inUse.indexOf(obj);
    if (index > -1) {
      this.inUse.splice(index, 1);
    }

    // Reset to clean state so the next borrower gets a fresh copy
    this.reset(obj);

    this.available.push(obj);
  }

  /**
   * Return ALL currently in-use objects to the pool at once.
   * Useful at the end of a frame or when clearing the simulation —
   * faster than releasing objects one by one.
   */
  public releaseAll(): void {
    for (const obj of this.inUse) {
      this.reset(obj);
      this.available.push(obj);
    }
    this.inUse = [];
  }

  /** Snapshot of pool usage for the debug overlay. */
  public getStats(): { available: number; inUse: number; total: number } {
    return {
      available: this.available.length,
      inUse: this.inUse.length,
      total: this.available.length + this.inUse.length,
    };
  }

  /** Discard all objects (both available and in-use). Use when shutting down. */
  public clear(): void {
    this.available = [];
    this.inUse = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CIRCULAR BUFFER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Circular (ring) buffer — a fixed-size array that wraps around.
 *
 * PROBLEM WITH REGULAR ARRAYS FOR ROLLING WINDOWS:
 *   You want to track the last 60 FPS measurements. With a plain array:
 *     history.push(newValue);          // O(1)
 *     if (history.length > 60) history.shift(); // O(n) — shifts 60 elements!
 *   The shift() call copies all 60 elements one slot to the left every frame.
 *   At 60 FPS × 60 elements = 3,600 copies per second — wasteful.
 *
 * HOW A CIRCULAR BUFFER SOLVES THIS:
 *   Allocate exactly `size` slots once. Keep a write pointer that advances
 *   forward and wraps back to 0 when it reaches the end. The oldest value
 *   is simply overwritten in place — no shifting, no GC.
 *
 * MODULO WRAPPING:
 *   writeIndex = (writeIndex + 1) % size
 *   With size=4 and indices 0,1,2,3: after index 3, (3+1) % 4 = 0. Back to start.
 *   The "%" (modulo) operator returns the remainder after integer division.
 *   This is how the "ring" is simulated in a flat array.
 *
 * READING IN ORDER:
 *   After the buffer fills up, writeIndex points to the OLDEST slot
 *   (because the next write will overwrite it). So to read oldest→newest:
 *     start at writeIndex, iterate buffer.length times, wrapping with modulo.
 *
 *   Example — size 4, writeIndex=2 (just wrote here):
 *     Slots: [3, 4, 1, 2]   (values in insertion order: 1, 2, 3, 4)
 *             ^     ^writeIndex points here
 *   Reading from writeIndex: buffer[2]=1, buffer[3]=2, buffer[0]=3, buffer[1]=4 ✓
 *
 * @template T The type of values stored in the buffer.
 */
export class CircularBuffer<T> {
  // The fixed-size backing array. Allocated once in the constructor.
  private buffer: T[];

  // Next write position. After each push(), this advances and wraps.
  private writeIndex: number = 0;

  // How many valid items are currently in the buffer (caps at buffer.length).
  // This distinguishes "buffer not yet full" from "buffer is full and wrapping."
  private count: number = 0;

  /**
   * @param size Maximum number of items to store. Fixed for the lifetime of this buffer.
   */
  constructor(size: number) {
    // new Array(size) allocates the array with `size` undefined slots.
    // We never resize it — that's the whole point.
    this.buffer = new Array(size);
  }

  /**
   * Add an item. If the buffer is full, the oldest item is silently overwritten.
   *
   * Cost: O(1) — one array write, one modulo, one comparison. No allocation.
   */
  public push(item: T): void {
    this.buffer[this.writeIndex] = item;

    // Advance write pointer, wrapping around when it hits the end
    this.writeIndex = (this.writeIndex + 1) % this.buffer.length;

    // Increment count, but never exceed the buffer size
    if (this.count < this.buffer.length) {
      this.count++;
    }
    // When count already equals buffer.length, the buffer is full and we're
    // overwriting — count stays the same. No off-by-one error here.
  }

  /**
   * Returns all items in chronological order (oldest → newest).
   *
   * If the buffer isn't full yet: just return the filled portion.
   * If the buffer is full: unroll from writeIndex (oldest) around to writeIndex-1 (newest).
   *
   * Cost: O(n) — must build a new array. Don't call this every frame;
   * instead, call it when you need to display or compute over the whole history.
   */
  public getAll(): T[] {
    if (this.count < this.buffer.length) {
      // Buffer not yet full — all valid data is at indices 0..count-1
      return this.buffer.slice(0, this.count);
    }

    // Buffer is full — reconstruct in chronological order using the modulo trick
    const result: T[] = [];
    for (let i = 0; i < this.buffer.length; i++) {
      const index = (this.writeIndex + i) % this.buffer.length;
      result.push(this.buffer[index]);
    }
    return result;
  }

  /**
   * Returns the N most recent items (newest are at the end of the result array).
   * Useful for computing a short rolling average without allocating the full array.
   *
   * @param n How many recent items to return. Capped at the actual item count.
   */
  public getLast(n: number): T[] {
    const all = this.getAll();
    return all.slice(Math.max(0, all.length - n));
  }

  /**
   * Reset to empty state. Re-allocates the backing array to clear stale data
   * (not strictly necessary but prevents accidental reads of old values).
   */
  public clear(): void {
    this.writeIndex = 0;
    this.count = 0;
    this.buffer = new Array(this.buffer.length);
  }

  /** Number of items currently in the buffer (0 to size). */
  public getSize(): number {
    return this.count;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE CACHE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Memoization cache with time-based expiry (TTL = Time To Live).
 *
 * WHAT IS MEMOIZATION?
 *   If a function always returns the same output for a given input,
 *   you can cache the result the first time and skip the computation on
 *   subsequent calls with the same input.
 *
 *   Example: atmospheric density at altitude 10,000m is always the same value.
 *   Instead of solving the barometric formula every frame, solve it once,
 *   cache the result, and look it up on future frames.
 *
 * WHY A TTL (expiry)?
 *   Some inputs produce values that change over time. The TTL forces a
 *   fresh calculation after `ttl` milliseconds so the cache doesn't serve
 *   stale results forever. After expiry, the next get() recomputes everything.
 *
 * INVALIDATION STRATEGY — whole-cache vs per-key:
 *   This cache uses whole-cache invalidation: when any value expires, ALL
 *   cached values are cleared. This is simpler to implement and works well
 *   when all values have similar update rates (e.g., atmospheric constants
 *   are all computed from the same inputs that change together).
 *   Per-key TTL would be more granular but adds complexity we don't need here.
 *
 * @template TKey   The type of the cache key (e.g., number for altitude).
 * @template TValue The type of the cached value (e.g., number for density).
 */
export class ComputeCache<TKey, TValue> {
  // Stores key → computed value pairs
  private cache: Map<TKey, TValue> = new Map();

  // Function to call when a key isn't in the cache (or cache has expired)
  private compute: (key: TKey) => TValue;

  // How many milliseconds before the entire cache is invalidated
  private ttl: number;

  // When the cache was last cleared
  private lastInvalidation: number = Date.now();

  /**
   * @param compute Function that produces a TValue from a TKey.
   *                Should be deterministic (same key → same value).
   * @param ttl     How long cached values remain valid (milliseconds).
   *                Default 1000ms = 1 second.
   */
  constructor(compute: (key: TKey) => TValue, ttl: number = 1000) {
    this.compute = compute;
    this.ttl = ttl;
  }

  /**
   * Look up a cached value, computing it if not cached (or if cache expired).
   *
   * PERFORMANCE:
   *   Map.has() and Map.get() are O(1) hash lookups — much faster than
   *   recomputing a complex function. For atmospheric calculations that involve
   *   multiple exponentials and conditionals, caching can be 10-100x faster.
   *
   * @param key The lookup key (e.g., altitude in meters).
   * @returns The cached or freshly computed value.
   */
  public get(key: TKey): TValue {
    // Check if cache has expired — if so, clear it and start fresh
    if (Date.now() - this.lastInvalidation > this.ttl) {
      this.cache.clear();
      this.lastInvalidation = Date.now();
    }

    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    // Cache miss — compute, store, and return
    const value = this.compute(key);
    this.cache.set(key, value);
    return value;
  }

  /** Force immediate cache clear regardless of TTL. Use when inputs change. */
  public invalidate(): void {
    this.cache.clear();
    this.lastInvalidation = Date.now();
  }

  /** Statistics for debugging — how many values are currently cached. */
  public getStats(): { size: number; ttl: number } {
    return { size: this.cache.size, ttl: this.ttl };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH PROCESSOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Splits a large array of work across multiple game loop frames.
 *
 * PROBLEM:
 *   Loading a 10,000-item dataset and processing it all in one frame would
 *   take 50ms+ — far exceeding the 16ms budget and causing a visible freeze.
 *
 * SOLUTION — temporal batching:
 *   Process `batchSize` items per frame instead of all at once. Spread the
 *   cost across many frames so each frame stays under budget.
 *
 * EXAMPLE:
 *   processor.queue(10000Items);
 *   // In game loop:
 *   const done = processor.processBatch(item => process(item));
 *   // First frame: items 0-99 (100ms worth? no — just 100 items * cost each)
 *   // Second frame: items 100-199
 *   // ...100th frame: items 9900-9999, done = true
 *
 * @template T The type of item in the work array.
 */
export class BatchProcessor<T> {
  private items: T[] = [];
  private batchSize: number;
  private index: number = 0;
  private onComplete?: () => void;

  /**
   * @param batchSize How many items to process per processBatch() call.
   *                  Default 100. Tune based on cost per item.
   *                  If each item takes 0.1ms, batchSize=100 costs ~10ms/frame.
   */
  constructor(batchSize: number = 100) {
    this.batchSize = batchSize;
  }

  /**
   * Load a new set of items to process. Resets the progress index to 0.
   * Replaces any previously queued (unfinished) items.
   */
  public queue(newItems: T[]): void {
    this.items = newItems;
    this.index = 0;
  }

  /**
   * Process the next batch. Call once per game loop frame.
   *
   * @param processor Applied to each item in the current batch.
   * @returns true when all items have been processed; false if more remain.
   */
  public processBatch(processor: (item: T) => void): boolean {
    // Calculate the end index for this batch (don't go past array length)
    const endIndex = Math.min(this.index + this.batchSize, this.items.length);

    for (let i = this.index; i < endIndex; i++) {
      processor(this.items[i]);
    }

    this.index = endIndex;

    const isDone = this.index >= this.items.length;
    if (isDone && this.onComplete) {
      this.onComplete();
    }
    return isDone;
  }

  /**
   * Returns processing progress as a fraction 0.0 to 1.0.
   * Useful for drawing a progress bar.
   *   0.0 = not started, 1.0 = all done
   */
  public getProgress(): number {
    if (this.items.length === 0) return 1;
    return this.index / this.items.length;
  }

  /** Discard all queued items and reset. Useful if the work is no longer needed. */
  public cancel(): void {
    this.items = [];
    this.index = 0;
  }

  /** Register a callback that fires exactly once when all items are processed. */
  public onCompleted(callback: () => void): void {
    this.onComplete = callback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAJECTORY POINT POOL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Specialized pool for {x, y} trajectory points.
 *
 * WHY SPECIALIZED?
 *   Generic ObjectPool<{x:number, y:number}> would work but adds overhead from
 *   the inUse tracking array and indexOf() lookups. Trajectory points are
 *   added at 60Hz and removed in bulk — a simpler stack-based pool is faster.
 *
 * STACK (LIFO) BEHAVIOR:
 *   getPoint() pops the last element (O(1)).
 *   returnPoint() pushes to the end (O(1)).
 *   No O(n) indexOf() needed because we never need to return a specific point;
 *   any available {x, y} object is equivalent to any other.
 *
 * CAPACITY LIMIT:
 *   returnPoint() won't grow the pool beyond poolSize. If you return more
 *   points than the pool was initialized with, the excess are discarded
 *   (and GC'd). This caps memory at a known ceiling.
 */
export class TrajectoryPointPool {
  private available: Array<{ x: number; y: number }> = [];
  private poolSize: number;

  /**
   * @param initialSize Pre-allocate this many {x, y} objects.
   *                    10,000 objects × ~32 bytes = ~320KB — well within budget.
   */
  constructor(initialSize: number = 10000) {
    this.poolSize = initialSize;
    for (let i = 0; i < initialSize; i++) {
      this.available.push({ x: 0, y: 0 });
    }
  }

  /**
   * Borrow a point, setting it to (x, y).
   * If the pool is empty, a new {x, y} object is allocated.
   *
   * @param x World-space X coordinate (meters from launch pad)
   * @param y World-space Y coordinate (meters altitude, 0 = ground)
   */
  public getPoint(x: number, y: number): { x: number; y: number } {
    if (this.available.length > 0) {
      const point = this.available.pop()!;
      point.x = x;
      point.y = y;
      return point;
    }
    // Pool exhausted — allocate fresh (rare if poolSize was set appropriately)
    return { x, y };
  }

  /**
   * Return a point to the pool after use.
   * The caller must not use the object after calling this.
   *
   * @param point The previously borrowed point.
   */
  public returnPoint(point: { x: number; y: number }): void {
    if (this.available.length < this.poolSize) {
      this.available.push(point);
    }
    // If over capacity, discard: the object will be GC'd but the pool stays bounded
  }

  /** Empty the pool and refill with fresh {x:0, y:0} objects. */
  public clear(): void {
    this.available = [];
    for (let i = 0; i < this.poolSize; i++) {
      this.available.push({ x: 0, y: 0 });
    }
  }

  /** How many points are in the pool and what is its max capacity. */
  public getStats(): { available: number; capacity: number } {
    return {
      available: this.available.length,
      capacity: this.poolSize,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MATH UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Floating-point near-equality comparison.
 *
 * WHY NOT USE ===?
 *   0.1 + 0.2 === 0.3  →  false   (it equals 0.30000000000000004 in IEEE 754)
 *   approximately(0.1 + 0.2, 0.3)  →  true
 *
 *   IEEE 754 double-precision floats can't represent all decimal fractions exactly.
 *   Instead of checking exact equality, we check if the difference is tiny enough
 *   to be a rounding error.
 *
 * @param a       First value
 * @param b       Second value
 * @param epsilon Tolerance — values within this distance are considered equal.
 *                Default 0.0001 works for physics units (meters, m/s, kg).
 */
export function approximately(a: number, b: number, epsilon: number = 0.0001): boolean {
  return Math.abs(a - b) < epsilon;
}

/**
 * Clamp a value to stay within [min, max].
 *
 * Examples:
 *   clamp(150, 0, 100) → 100  (too big — capped at max)
 *   clamp(-5, 0, 100)  → 0    (too small — floored at min)
 *   clamp(42, 0, 100)  → 42   (in range — unchanged)
 *
 * Used constantly in physics (e.g., throttle must stay in [0, 1])
 * and rendering (e.g., alpha must stay in [0, 1]).
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation between two values.
 *
 * FORMULA: result = a + (b - a) × t
 *   t=0.0 → result = a    (fully at a)
 *   t=0.5 → result = midpoint between a and b
 *   t=1.0 → result = b    (fully at b)
 *
 * EXAMPLE — camera smoothing:
 *   camera.zoom = lerp(camera.zoom, targetZoom, 0.05);
 *   Each frame, zoom moves 5% of the remaining distance toward targetZoom.
 *   This creates a smooth ease-in effect that never quite reaches the target
 *   (but visually reaches it within ~60 frames at t=0.05).
 *
 * t is clamped to [0, 1] so you can't overshoot beyond b.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Quadratic ease-out: starts fast, decelerates to a smooth stop.
 *
 * FORMULA: result = t × (2 - t)
 *   t=0.0 → 0.0   (start)
 *   t=0.5 → 0.75  (halfway through, but 75% of the way to the end)
 *   t=1.0 → 1.0   (end, fully arrived)
 *
 *   The curve starts steep (fast) and flattens (slows) near the end.
 *   This feels natural for physical objects coming to rest or UI elements
 *   sliding into their final position.
 *
 * Used with lerp: lerp(a, b, easeOut(t)) makes the transition decelerate.
 */
export function easeOut(t: number): number {
  return t * (2 - t);
}

/**
 * Quadratic ease-in: starts slow, accelerates to full speed.
 *
 * FORMULA: result = t²
 *   t=0.0 → 0.0  (start, barely moving)
 *   t=0.5 → 0.25 (halfway through time, only 25% of the way to the end)
 *   t=1.0 → 1.0  (end, arrived)
 *
 *   The curve is flat at the start (very slow) and steep at the end (very fast).
 *   This simulates objects that are heavy and need time to build up speed,
 *   like a rocket liftoff or a camera zooming in slowly then rushing toward a target.
 */
export function easeIn(t: number): number {
  return t * t;
}
