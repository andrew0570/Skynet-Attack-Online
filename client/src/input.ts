type KeyboardLock = { lock(keys?: string[]): Promise<void>; unlock(): void };

/**
 * Keyboard + pointer-locked mouse. Press events persist until a sim tick consumes them.
 *
 * Engaging also enters fullscreen with the Keyboard Lock API, because Ctrl is the glide key and
 * browsers otherwise reserve shortcuts like Ctrl+W (close tab) — fatal mid-glide while holding W.
 */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  locked = false;

  constructor(private target: HTMLElement) {
    window.addEventListener('keydown', e => {
      if (this.locked) {
        // Swallow browser shortcuts (Ctrl+S, Ctrl+D, ...) while playing.
        e.preventDefault();
        if (e.code === 'Escape') this.disengage();
      }
      if (!e.repeat) this.pressed.add(e.code);
      this.held.add(e.code);
    });
    window.addEventListener('keyup', e => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
    target.addEventListener('mousedown', e => {
      if (!this.locked) {
        this.engage();
        return;
      }
      this.pressed.add(`Mouse${e.button}`);
      this.held.add(`Mouse${e.button}`);
    });
    window.addEventListener('mouseup', e => this.held.delete(`Mouse${e.button}`));
    target.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.target;
      if (!this.locked) this.held.clear();
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  private engage(): void {
    const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
    document.documentElement
      .requestFullscreen?.()
      .then(() => keyboard?.lock())
      .catch(() => {
        /* fullscreen/keyboard lock unavailable: game still works, Ctrl+W just isn't capturable */
      });
    this.target.requestPointerLock();
  }

  private disengage(): void {
    (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard?.unlock();
    document.exitPointerLock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Call after a sim tick has read this frame's presses. */
  clearPressed(): void {
    this.pressed.clear();
  }

  takeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }
}
