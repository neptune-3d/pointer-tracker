# @neptune3d/pointer-tracker

A lightweight utility for managing pointer interactions across mouse, touch, and stylus input. Tracks active pointers, abstracts pointer capture, and supports gesture composition for drag, pinch, and pointer lock scenarios.

## 🚀 Installation

```bash
npm install @neptune3d/pointer-tracker
```

## 📦 Basic Usage

```ts
import { PointerTracker } from "@neptune3d/pointer-tracker";

const tracker = new PointerTracker({
  onPointerDown: (e) => {
    console.log("Pointer down:", e.pointerId);
  },
  onActivePointerMove: (e) => {
    console.log("Pointer move:", e.pointerId, e.pageX, e.pageY);
  },
  onPointerEnd: (e) => {
    console.log("Pointer ended:", e.pointerId);
  },
});

tracker.connect(myElement); // Attach to a DOM element
```

## ✨ Features

- Tracks multiple active pointers (`pointerId`, position, button)
- Automatically manages pointer capture and release
- Supports pointer lock (`mousemove` deltas)
- Emits synthetic resume events for multi-touch transitions
- Provides helper methods:
  - `getPointer(id)` – latest position and button
  - `getActivePointers()` – all tracked pointers
  - `getCenter()` – centroid of active pointers
  - `getDistance(a, b)` – distance between two pointers
  - `getNDCPointer(id, element)` – normalized device coordinates

## 🧹 Cleanup

```ts
tracker.disconnect(); // Removes all listeners and clears state
```
