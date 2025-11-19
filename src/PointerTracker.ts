/**
 * PointerTracker is a utility for managing pointer interactions on an element.
 *
 * It abstracts away the boilerplate of handling pointerdown/move/up/cancel events,
 * and keeps track of all currently active pointers (supporting multi-touch).
 *
 * Features:
 * - Tracks active pointer IDs and their latest positions.
 * - Automatically sets and releases pointer capture on the target element.
 * - Invokes user-provided callbacks for pointer down, move, and end events.
 * - Supports a "synthetic pointer down" event: when multiple pointers are active
 *   and one ends, the remaining pointer is re-emitted as if it just went down.
 *   This is useful for gestures that transition between multi-touch and single-touch.
 *
 * Usage:
 * ```ts
 * const tracker = new PointerTracker({
 *     onPointerDown: (e) => { ... },
 *     onActivePointerMove: (e) => { ... },
 *     onPointerEnd: (e) => { ... },
 *     onSingleTouchResume: (e) => { ... }
 *   });
 *
 * tracker.connect(domElement);
 * ...
 * tracker.disconnect();
 * ```
 */
export class PointerTracker {
  constructor(props?: PointerTrackerProps) {
    this.onPointerDownCallback = props?.onPointerDown;
    this.onActivePointerMoveCallback = props?.onActivePointerMove;
    this.onPointerCancelCallback = props?.onPointerCancel;
    this.onPointerUpCallback = props?.onPointerUp;
    this.onPointerEndCallback = props?.onPointerEnd;
    this.onMouseMoveLockedCallback = props?.onMouseMoveLocked;
    this.onPointerMoveCallback = props?.onPointerMove;
    this.onSingleTouchResume = props?.onSingleTouchResume;
  }

  protected onPointerDownCallback;
  protected onActivePointerMoveCallback;
  protected onPointerCancelCallback;
  protected onPointerUpCallback;
  protected onPointerEndCallback;
  protected onMouseMoveLockedCallback;
  protected onPointerMoveCallback;
  protected onSingleTouchResume;

  protected activePointerIds: Set<number> = new Set();
  protected pointers: Map<number, Pointer> = new Map();
  protected element: HTMLElement | null = null;
  protected isPointerLocked: boolean = false;

  /**
   * Attaches the tracker to a specific DOM element and begins listening
   * for pointer events on it.
   *
   * - Stores a reference to the element.
   * - Adds listeners for `pointerdown` (to start tracking) and
   *   `pointercancel` (to handle unexpected cancellations).
   * - Additional listeners for `pointermove` and `pointerup` are only
   *   attached dynamically when the first pointer goes down, ensuring
   *   minimal overhead until interaction begins.
   *
   * Call this once to activate tracking on the desired element.
   *
   * @param element The HTMLElement to attach pointer event listeners to.
   */
  connect(element: HTMLElement) {
    this.element = element;

    element.addEventListener("pointerdown", this.onPointerDown);
    element.addEventListener("pointercancel", this.onPointerCancel);

    element.ownerDocument.addEventListener(
      "pointerlockchange",
      this.onPointerLockChange
    );

    element.ownerDocument.addEventListener(
      "pointerlockerror",
      this.onPointerLockError
    );

    element.ownerDocument.addEventListener(
      "mousemove",
      this.onMouseMoveWhileLocked
    );

    if (this.onPointerMoveCallback) {
      element.addEventListener("pointermove", this.onPointerMoveCallback);
    }
  }

  /**
   * Detaches the tracker from its current element and cleans up all
   * event listeners and state.
   *
   * - Removes all pointer event listeners (`down`, `move`, `up`, `cancel`).
   * - Clears the set of active pointers and their stored positions.
   * - Releases the element reference so the tracker can be safely
   *   garbage‑collected or re‑connected to another element later.
   *
   * Call this when you no longer need pointer tracking, e.g. on component
   * unmount or teardown, to prevent memory leaks and dangling listeners.
   */
  disconnect() {
    if (!this.element) return;

    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onActivePointerMove);
    this.element.removeEventListener("pointerup", this.onPointerUp);
    this.element.removeEventListener("pointercancel", this.onPointerCancel);

    this.element.ownerDocument.removeEventListener(
      "pointerlockchange",
      this.onPointerLockChange
    );

    this.element.ownerDocument.removeEventListener(
      "pointerlockerror",
      this.onPointerLockError
    );

    this.element.ownerDocument.removeEventListener(
      "mousemove",
      this.onMouseMoveWhileLocked
    );

    if (this.onPointerMoveCallback) {
      this.element.removeEventListener(
        "pointermove",
        this.onPointerMoveCallback
      );
    }

    this.activePointerIds.clear();
    this.pointers.clear();

    this.element = null;
  }

  /**
   * Retrieves the latest tracked position and button state for a given pointer ID.
   *
   * @param pointerId - The unique identifier of the pointer (from PointerEvent.pointerId).
   * @return The raw screen-space pointer info (pageX, pageY, button), or undefined if not tracked.
   */
  getPointer(pointerId: number): Pointer | undefined {
    return this.pointers.get(pointerId);
  }

  /**
   * Returns an array of all currently tracked pointers.
   *
   * Each pointer represents an active interaction on the target element,
   * including its latest screen-space position (`pageX`, `pageY`) and button state.
   *
   * Useful for multi-touch gestures, drag tracking, or gesture composition.
   *
   * @return An array of `PointerInfo` objects for all active pointer IDs.
   */
  getActivePointers(): Pointer[] {
    return Array.from(this.pointers.values());
  }

  /**
   * Computes the normalized device coordinates (NDC) for a given pointer ID,
   * relative to the specified DOM element.
   *
   * Converts the pointer's position from viewport-space (clientX/clientY) to NDC:
   * - x ∈ [-1, 1] from left to right
   * - y ∈ [-1, 1] from bottom to top
   *
   * Useful for raycasting or mapping pointer input to 3D space.
   *
   * @param pointerId - The unique identifier of the pointer to normalize.
   * @param target - A Point object to write results into, allowing reuse and avoiding allocations.
   * @param rect - Optional bounding box of the element. Can be a lightweight `Rect` or a native `DOMRect`.
   *               Passing this allows callers to cache `getBoundingClientRect()` for performance.
   *               If omitted, the method will query the element’s rect internally.
   * @return The normalized pointer coordinates written into `target`, or null if the pointer is not tracked
   *         or the rect has zero width/height.
   */
  getNDCPoint(pointerId: number, target?: Point, rect?: Rect): Point | null {
    if (!this.element || this.isPointerLocked) return null;

    const p = this.getPointer(pointerId);
    if (!p) return null;

    const _rect = rect ?? this.element.getBoundingClientRect();

    if (_rect.width === 0 || _rect.height === 0) return null;

    if (!target) target = { x: 0, y: 0 };

    target.x = ((p.clientX - _rect.left) / _rect.width) * 2 - 1;
    target.y = (-(p.clientY - _rect.top) / _rect.height) * 2 + 1;

    return target;
  }

  /**
   * Computes the centroid of all currently tracked pointers.
   *
   * This is the average position of all active pointers in viewport-space coordinates
   * (`clientX`/`clientY`), and is commonly used as the anchor point for pinch-to-zoom,
   * rotate, or multi-touch gestures.
   *
   * If no pointers are active, returns `null`.
   *
   * @param target - A Point object to write results into, allowing reuse and avoiding allocations.
   * @return The center point `{ x, y }` in viewport-space, written into `target`,
   *         or `null` if no pointers are tracked.
   */
  getCenter(target?: Point): Point | null {
    const values = Array.from(this.pointers.values());
    if (values.length === 0) return null;

    const sum = values.reduce(
      (acc, p) => ({
        x: acc.x + p.clientX,
        y: acc.y + p.clientY,
      }),
      { x: 0, y: 0 }
    );

    if (!target) target = { x: 0, y: 0 };

    target.x = sum.x / values.length;
    target.y = sum.y / values.length;

    return target;
  }

  /**
   * Calculates the Euclidean distance between two tracked pointers.
   *
   * This is useful for detecting pinch gestures, scaling interactions,
   * or measuring separation between touch points.
   *
   * If either pointer is not currently tracked, returns `null`.
   *
   * @param a - The pointer ID of the first pointer.
   * @param b - The pointer ID of the second pointer.
   * @return The distance in pixels between the two pointers, or `null` if either is missing.
   */
  getDistance(a: number, b: number): number | null {
    const p1 = this.getPointer(a);
    const p2 = this.getPointer(b);
    if (!p1 || !p2) return null;

    const dx = p2.clientX - p1.clientX;
    const dy = p2.clientY - p1.clientY;

    return Math.hypot(dx, dy);
  }

  protected onPointerDown = (event: PointerEvent) => {
    if (!this.element || this.isPointerLocked) return;

    // Capture this pointerId individually
    this.element.setPointerCapture(event.pointerId);

    // Attach listeners once (on first pointer)
    if (this.activePointerIds.size === 0) {
      this.element.addEventListener("pointermove", this.onActivePointerMove);
      this.element.addEventListener("pointerup", this.onPointerUp);
    }

    // Register pointer if new
    if (!this.activePointerIds.has(event.pointerId)) {
      this.activePointerIds.add(event.pointerId);
      this.pointers.set(event.pointerId, {
        pageX: event.pageX,
        pageY: event.pageY,
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button,
      });
    }

    this.onPointerDownCallback?.(event);
  };

  protected onActivePointerMove = (event: PointerEvent) => {
    if (this.activePointerIds.has(event.pointerId)) {
      // Always update position
      this.pointers.set(event.pointerId, {
        pageX: event.pageX,
        pageY: event.pageY,
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button,
      });
    }

    this.onActivePointerMoveCallback?.(event);
  };

  protected cleanup(event: PointerEvent) {
    if (!this.element) return;

    this.activePointerIds.delete(event.pointerId);
    this.pointers.delete(event.pointerId);

    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }

    if (this.activePointerIds.size === 0) {
      this.element.removeEventListener("pointermove", this.onActivePointerMove);
      this.element.removeEventListener("pointerup", this.onPointerUp);
    }
  }

  protected onPointerCancel = (event: PointerEvent) => {
    this.cleanup(event);
    this.onPointerCancelCallback?.(event);
    this.onPointerEndCallback?.(event);
  };

  protected onPointerUp = (event: PointerEvent) => {
    this.cleanup(event);
    this.onPointerUpCallback?.(event);
    this.onPointerEndCallback?.(event);

    // Resume single‑touch gesture if only one pointer remains
    if (this.activePointerIds.size === 1 && this.onSingleTouchResume) {
      const [remainingId] = this.activePointerIds;
      const pos = this.pointers.get(remainingId);
      if (pos) {
        this.onSingleTouchResume({
          pointerId: remainingId,
          pageX: pos.pageX,
          pageY: pos.pageY,
          clientX: pos.clientX,
          clientY: pos.clientY,
          button: pos.button,
        });
      }
    }
  };

  protected onPointerLockChange = () => {
    this.isPointerLocked = document.pointerLockElement === this.element;
  };

  protected onPointerLockError = () => {
    console.warn("PointerTracker: Failed to acquire pointer lock.");
    this.isPointerLocked = false;
  };

  protected onMouseMoveWhileLocked = (event: MouseEvent) => {
    if (!this.isPointerLocked) return;
    this.onMouseMoveLockedCallback?.(event);
  };
}

export type PointerTrackerProps = {
  /**
   * Called when a new pointer goes down on the element.
   * Fires once per unique pointerId when it first becomes active.
   */
  onPointerDown?: (event: PointerEvent) => void;

  /**
   * Called whenever an active pointer moves.
   * Fires continuously as long as the pointerId is tracked.
   */
  onActivePointerMove?: (event: PointerEvent) => void;

  /**
   * Called when a pointer is forcefully cancelled by the browser or OS.
   * This may occur due to external gestures (e.g. pinch‑zoom, two‑finger scroll),
   * context menu activation, or other interruptions that invalidate the pointer.
   * Consumers can use this to reset state or abort ongoing interactions.
   */
  onPointerCancel?: (event: PointerEvent) => void;

  /**
   * Called when a tracked pointer ends normally via a `pointerup` event.
   * Fires once per pointerId when the user releases the pointer,
   * allowing consumers to finalize drag gestures or commit changes.
   * Unlike `onPointerCancel`, this represents a graceful completion.
   */
  onPointerUp?: (event: PointerEvent) => void;

  /**
   * Called when a pointer ends (pointerup or pointercancel).
   * If this was the last active pointer, the tracker will also
   * release pointer capture and remove move/up listeners.
   */
  onPointerEnd?: (event: PointerEvent) => void;

  /**
   * Called whenever a `mousemove` event is received while pointer lock is active.
   *
   * Unlike standard pointer tracking, this callback delivers movement deltas (`movementX`, `movementY`)
   * rather than absolute positions, and does not include a `pointerId`. It is triggered only when
   * `document.pointerLockElement === element`, allowing consumers to handle camera movement,
   * first-person controls, or other relative input scenarios.
   *
   * The full `MouseEvent` is passed to preserve access to modifier keys, buttons, and raw deltas.
   */
  onMouseMoveLocked?: (event: MouseEvent) => void;

  /**
   * Called whenever a `pointermove` event is received on the target element,
   * regardless of whether the pointer is actively tracked.
   *
   * Unlike `onActivePointerMove`, which fires only for pointers currently tracked by the system,
   * this callback mirrors the raw DOM `pointermove` stream and may include untracked or passive pointers.
   *
   * Useful for passive hover effects, non-captured movement, or supplemental gesture logic.
   */
  onPointerMove?: (event: PointerEvent) => void;

  /**
   * Called when multiple pointers were active and one ends,
   * leaving exactly one pointer still active.
   *
   * This "synthetic" down event re‑emits the remaining pointer
   * as if it had just gone down, which is useful for gestures
   * that transition smoothly from multi‑touch back to single‑touch.
   */
  onSingleTouchResume?: (event: SyntheticPointerDownEvent) => void;
};

export type SyntheticPointerDownEvent = {
  pointerId: number;
  pageX: number; // absolute page coordinates
  pageY: number;
  clientX: number; // viewport-relative coordinates
  clientY: number;
  button: number;
};

export type Pointer = {
  pageX: number;
  pageY: number;
  clientX: number;
  clientY: number;
  button: number;
};

export type Point = { x: number; y: number };

export type Rect = {
  left: number;
  width: number;
  top: number;
  height: number;
};

// Potential additions
// - onPointerEnter?: (event: PointerEvent) => void / onPointerLeave?: (event: PointerEvent) => void
// - Useful for hover effects or gesture pre‑activation.
// - Mirrors DOM events but scoped to tracked pointers.
// - onGestureStart?: (pointers: Map<number, PointerState>) => void
// - Fires when more than one pointer becomes active (multi‑touch gesture begins).
// - Lets consumers initialize pinch/zoom/rotate logic cleanly.
// - onGestureChange?: (pointers: Map<number, PointerState>) => void
// - Fires whenever the set of active pointers changes (move, add, remove).
// - Provides a consolidated hook for gesture math (distance, centroid, rotation).
// - onGestureEnd?: () => void
// - Fires when the last pointer ends, signaling the gesture is complete.
// - Complements onPointerEnd but at the gesture level.
// - onPointerCaptureLost?: (event: PointerEvent) => void
// - Handles the rare case where pointer capture is lost unexpectedly (e.g. element removed).
// - Gives consumers a chance to reset state gracefully.
