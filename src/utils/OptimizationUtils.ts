/**
 * ROCKET SIMULATOR - OPTIMIZATION UTILITIES
 * =========================================
 * Low-level optimization utilities for performance-critical systems.
 * 
 * Includes:
 * - Object pooling (reuse objects instead of creating new ones)
 * - Memory-efficient data structures
 * - Caching strategies
 * - Batch processing optimizations
 * 
 * These utilities help reduce garbage collection pressure and memory allocations
 * during intensive operations like particle updates.
 */

/**
 * Simple Object Pool for particle reuse
 * Instead of creating new particle objects every frame,
 * we reuse existing ones from a pool. This reduces garbage collection.
 */
export class ObjectPool<T> {
  // Array of available objects ready to be used
  private available: T[] = [];

  // Array of currently-in-use objects
  private inUse: T[] = [];

  // Function to create new objects when pool is empty
  private factory: () => T;

  // Function to reset an object to initial state
  private reset: (obj: T) => void;

  /**
   * Create an object pool
   * 
   * @param factory - Function that creates new objects
   * @param reset - Function that resets objects to reusable state
   * @param initialSize - How many objects to pre-allocate
   */
  constructor(
    factory: () => T,
    reset: (obj: T) => void,
    initialSize: number = 100
  ) {
    this.factory = factory;
    this.reset = reset;

    // Pre-allocate objects so we have them ready
    for (let i = 0; i < initialSize; i++) {
      this.available.push(factory());
    }
  }

  /**
   * Get an object from the pool
   * Either reuses one or creates a new one if pool is empty
   */
  public acquire(): T {
    let obj: T;

    // If pool has objects, reuse one
    if (this.available.length > 0) {
      obj = this.available.pop()!;
    } else {
      // Otherwise create a new one (pool is empty)
      obj = this.factory();
    }

    // Track that this object is in use
    this.inUse.push(obj);
    return obj;
  }

  /**
   * Return an object to the pool after use
   * Resets it and makes it available for reuse
   */
  public release(obj: T): void {
    // Remove from in-use list
    const index = this.inUse.indexOf(obj);
    if (index > -1) {
      this.inUse.splice(index, 1);
    }

    // Reset to clean state
    this.reset(obj);

    // Return to available pool
    this.available.push(obj);
  }

  /**
   * Release all objects back to pool
   * Call after batch operations complete
   */
  public releaseAll(): void {
    // Reset all in-use objects
    for (const obj of this.inUse) {
      this.reset(obj);
      this.available.push(obj);
    }

    // Clear in-use list
    this.inUse = [];
  }

  /**
   * Get current pool statistics
   */
  public getStats(): {
    available: number;
    inUse: number;
    total: number;
  } {
    return {
      available: this.available.length,
      inUse: this.inUse.length,
      total: this.available.length + this.inUse.length,
    };
  }

  /**
   * Clear the entire pool (useful for cleanup)
   */
  public clear(): void {
    this.available = [];
    this.inUse = [];
  }
}

/**
 * Circular Buffer for efficient history tracking
 * Fixed-size buffer that automatically overwrites oldest data
 * No need to shift arrays - just move pointer
 */
export class CircularBuffer<T> {
  // Fixed-size array
  private buffer: T[];

  // Current write position (next item goes here)
  private writeIndex: number = 0;

  // How many items are actually in the buffer
  private count: number = 0;

  /**
   * Create a circular buffer
   * 
   * @param size - Maximum items to store
   */
  constructor(size: number) {
    this.buffer = new Array(size);
  }

  /**
   * Add an item to the buffer
   * Automatically overwrites oldest if full
   */
  public push(item: T): void {
    // Write item at current position
    this.buffer[this.writeIndex] = item;

    // Move write pointer to next position (wrap around if needed)
    this.writeIndex = (this.writeIndex + 1) % this.buffer.length;

    // Track count (cap at buffer size)
    if (this.count < this.buffer.length) {
      this.count++;
    }
  }

  /**
   * Get all items in order (oldest to newest)
   */
  public getAll(): T[] {
    if (this.count < this.buffer.length) {
      // Buffer not full yet, just return filled portion
      return this.buffer.slice(0, this.count);
    }

    // Buffer is full, need to reorder so oldest comes first
    const result: T[] = [];

    // Start from oldest (write position) and go around
    for (let i = 0; i < this.buffer.length; i++) {
      const index = (this.writeIndex + i) % this.buffer.length;
      result.push(this.buffer[index]);
    }

    return result;
  }

  /**
   * Get the last N items
   */
  public getLast(n: number): T[] {
    const all = this.getAll();
    return all.slice(Math.max(0, all.length - n));
  }

  /**
   * Clear the buffer
   */
  public clear(): void {
    this.writeIndex = 0;
    this.count = 0;
    this.buffer = new Array(this.buffer.length);
  }

  /**
   * Get buffer statistics
   */
  public getSize(): number {
    return this.count;
  }
}

/**
 * Simple caching system for computed values
 * Stores computed results so we don't recalculate every frame
 */
export class ComputeCache<TKey, TValue> {
  // Map of key -> cached value
  private cache: Map<TKey, TValue> = new Map();

  // Function to compute value if not cached
  private compute: (key: TKey) => TValue;

  // How often to invalidate cache (milliseconds)
  private ttl: number;

  // Last invalidation time
  private lastInvalidation: number = Date.now();

  /**
   * Create a compute cache
   * 
   * @param compute - Function to compute values
   * @param ttl - Time to live (how long to keep cached values)
   */
  constructor(compute: (key: TKey) => TValue, ttl: number = 1000) {
    this.compute = compute;
    this.ttl = ttl;
  }

  /**
   * Get a value (compute if not cached)
   */
  public get(key: TKey): TValue {
    // Check if cache has expired
    if (Date.now() - this.lastInvalidation > this.ttl) {
      this.cache.clear(); // Invalidate entire cache
      this.lastInvalidation = Date.now();
    }

    // Check if value is cached
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    // Compute and cache new value
    const value = this.compute(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * Invalidate cache immediately
   */
  public invalidate(): void {
    this.cache.clear();
    this.lastInvalidation = Date.now();
  }

  /**
   * Get cache statistics
   */
  public getStats(): {
    size: number;
    ttl: number;
  } {
    return {
      size: this.cache.size,
      ttl: this.ttl,
    };
  }
}

/**
 * Batch processing helper
 * Process large arrays in chunks to avoid frame stalls
 */
export class BatchProcessor<T> {
  // Items to process
  private items: T[] = [];

  // How many items to process per frame
  private batchSize: number;

  // Current processing index
  private index: number = 0;

  // Completion callback
  private onComplete?: () => void;

  /**
   * Create a batch processor
   *
   * @param batchSize - How many items to process per frame
   */
  constructor(batchSize: number = 100) {
    this.batchSize = batchSize;
  }

  /**
   * Queue items for processing
   */
  public queue(newItems: T[]): void {
    this.items = newItems;
    this.index = 0;
  }

  /**
   * Process one batch
   * Should be called once per frame
   *
   * @param processor - Function to process each item
   * @returns true if all items processed, false if more remain
   */
  public processBatch(processor: (item: T) => void): boolean {
    // Calculate end index for this batch
    const endIndex = Math.min(this.index + this.batchSize, this.items.length);

    // Process items in this batch
    for (let i = this.index; i < endIndex; i++) {
      processor(this.items[i]);
    }

    // Update position
    this.index = endIndex;

    // Check if done
    const isDone = this.index >= this.items.length;
    if (isDone && this.onComplete) {
      this.onComplete();
    }

    return isDone;
  }

  /**
   * Get processing progress (0-1)
   */
  public getProgress(): number {
    if (this.items.length === 0) return 1;
    return this.index / this.items.length;
  }

  /**
   * Cancel processing
   */
  public cancel(): void {
    this.items = [];
    this.index = 0;
  }

  /**
   * Set completion callback
   */
  public onCompleted(callback: () => void): void {
    this.onComplete = callback;
  }
}

/**
 * Memory pool for trajectory points
 * Reuses trajectory point objects instead of creating new ones
 */
export class TrajectoryPointPool {
  // Pool of available points
  private available: Array<{ x: number; y: number }> = [];

  // Pre-allocated size
  private poolSize: number;

  /**
   * Create trajectory point pool
   */
  constructor(initialSize: number = 10000) {
    this.poolSize = initialSize;

    // Pre-allocate points
    for (let i = 0; i < initialSize; i++) {
      this.available.push({ x: 0, y: 0 });
    }
  }

  /**
   * Get a point from the pool
   */
  public getPoint(x: number, y: number): { x: number; y: number } {
    let point: { x: number; y: number };

    if (this.available.length > 0) {
      // Reuse from pool
      point = this.available.pop()!;
      point.x = x;
      point.y = y;
    } else {
      // Create new if pool is empty
      point = { x, y };
    }

    return point;
  }

  /**
   * Return a point to the pool
   */
  public returnPoint(point: { x: number; y: number }): void {
    // Don't grow pool beyond initial size
    if (this.available.length < this.poolSize) {
      this.available.push(point);
    }
  }

  /**
   * Clear the pool
   */
  public clear(): void {
    this.available = [];
    for (let i = 0; i < this.poolSize; i++) {
      this.available.push({ x: 0, y: 0 });
    }
  }

  /**
   * Get pool statistics
   */
  public getStats(): {
    available: number;
    capacity: number;
  } {
    return {
      available: this.available.length,
      capacity: this.poolSize,
    };
  }
}

/**
 * Utility to calculate if two numbers are approximately equal
 * Avoids floating point comparison issues
 */
export function approximately(a: number, b: number, epsilon: number = 0.0001): boolean {
  return Math.abs(a - b) < epsilon;
}

/**
 * Utility to clamp a value between min and max
 * Used frequently in physics and animations
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation between two values
 * Used for smooth animations and transitions
 */
export function lerp(a: number, b: number, t: number): number {
  // t should be 0-1
  return a + (b - a) * clamp(t, 0, 1);
}

/**
 * Easing function: ease out (starts fast, slows down)
 * Used for animations that decelerate naturally
 */
export function easeOut(t: number): number {
  // Quadratic ease out
  return t * (2 - t);
}

/**
 * Easing function: ease in (starts slow, speeds up)
 * Used for animations that accelerate naturally
 */
export function easeIn(t: number): number {
  // Quadratic ease in
  return t * t;
}