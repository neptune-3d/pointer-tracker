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
    this.onPointerEndCallback = props?.onPointerEnd;
    this.onMouseMoveLockedCallback = props?.onMouseMoveLocked;
    this.onPointerMoveCallback = props?.onPointerMove;
    this.onSingleTouchResume = props?.onSingleTouchResume;
  }

  private onPointerDownCallback;
  private onActivePointerMoveCallback;
  private onPointerEndCallback;
  private onMouseMoveLockedCallback;
  private onPointerMoveCallback;
  private onSingleTouchResume;

  private activePointerIds: Set<number> = new Set();
  private pointers: Map<number, PointerInfo> = new Map();
  private element: HTMLElement | null = null;
  private isPointerLocked: boolean = false;

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
    element.addEventListener("pointercancel", this.onPointerEnd);

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
    if (this.element == null) return;

    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.removeEventListener("pointermove", this.onActivePointerMove);
    this.element.removeEventListener("pointerup", this.onPointerEnd);
    this.element.removeEventListener("pointercancel", this.onPointerEnd);

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
  getPointer(pointerId: number): PointerInfo | undefined {
    return this.pointers.get(pointerId);
  }

  /**
   * Computes the normalized device coordinates (NDC) for a given pointer ID,
   * relative to the specified DOM element.
   *
   * Converts the pointer's position from screen-space (pageX/pageY) to NDC:
   * - x ∈ [-1, 1] from left to right
   * - y ∈ [-1, 1] from bottom to top
   *
   * Useful for raycasting or mapping pointer input to 3D space.
   *
   * @param pointerId - The unique identifier of the pointer to normalize.
   * @param element - The DOM element whose bounds define the normalization frame.
   * @return The normalized pointer info (x, y, button), or null if the pointer is not tracked.
   */
  getNDCPointer(pointerId: number): PointerInfo | null {
    if (!this.element || this.isPointerLocked) return null;

    const p = this.getPointer(pointerId);
    if (!p) return null;

    const rect = this.element.getBoundingClientRect();
    return {
      x: ((p.x - rect.left) / this.element.clientWidth) * 2 - 1,
      y: (-(p.y - rect.top) / rect.height) * 2 + 1,
      button: p.button,
    };
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
  getActivePointers(): PointerInfo[] {
    return Array.from(this.pointers.values());
  }

  /**
   * Computes the centroid of all currently tracked pointers.
   *
   * This is the average position of all active pointers in screen-space coordinates,
   * and is commonly used as the anchor point for pinch-to-zoom, rotate, or multi-touch gestures.
   *
   * If no pointers are active, returns `null`.
   *
   * @return The center point `{ x, y }` in screen-space, or `null` if no pointers are tracked.
   */
  getCenter(): { x: number; y: number } | null {
    const values = Array.from(this.pointers.values());
    if (values.length === 0) return null;
    const sum = values.reduce(
      (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
      { x: 0, y: 0 }
    );
    return { x: sum.x / values.length, y: sum.y / values.length };
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
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.hypot(dx, dy);
  }

  protected onPointerDown = (event: PointerEvent) => {
    if (!this.element || this.isPointerLocked) return;

    if (this.activePointerIds.size === 0) {
      this.element.setPointerCapture(event.pointerId);
      this.element.addEventListener("pointermove", this.onActivePointerMove);
      this.element.addEventListener("pointerup", this.onPointerEnd);
    }

    if (!this.activePointerIds.has(event.pointerId)) {
      this.activePointerIds.add(event.pointerId);
      this.pointers.set(event.pointerId, {
        x: event.pageX,
        y: event.pageY,
        button: event.button,
      });
    }

    this.onPointerDownCallback?.(event);
  };

  protected onActivePointerMove = (event: PointerEvent) => {
    if (this.activePointerIds.has(event.pointerId)) {
      this.activePointerIds.add(event.pointerId);
      this.pointers.set(event.pointerId, {
        x: event.pageX,
        y: event.pageY,
        button: event.button,
      });
    }

    this.onActivePointerMoveCallback?.(event);
  };

  protected onPointerEnd = (event: PointerEvent) => {
    if (this.element == null) return;

    this.activePointerIds.delete(event.pointerId);
    this.pointers.delete(event.pointerId);

    if (this.activePointerIds.size === 0) {
      this.element.releasePointerCapture(event.pointerId);
      this.element.removeEventListener("pointermove", this.onActivePointerMove);
      this.element.removeEventListener("pointerup", this.onPointerEnd);

      this.onPointerEndCallback?.(event);
    }
    //
    else if (this.activePointerIds.size === 1 && this.onSingleTouchResume) {
      const [remainingId] = this.activePointerIds;
      const pos = this.pointers.get(remainingId);
      if (pos) {
        this.onSingleTouchResume({
          pointerId: remainingId,
          pageX: pos.x,
          pageY: pos.y,
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
  pageX: number;
  pageY: number;
  button: number;
};

export type PointerInfo = {
  x: number;
  y: number;
  button: number;
};
