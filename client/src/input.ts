/** Keyboard + pointer-locked mouse. Press events persist until a sim tick consumes them. */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  locked = false;

  constructor(private target: HTMLElement) {
    window.addEventListener('keydown', e => {
      // Typing in a form (the start screen) isn't game input — and Tab must still move focus.
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      // Swallow browser shortcuts while playing (Esc still releases pointer lock natively).
      if (this.locked || e.code === 'Tab') e.preventDefault(); // Tab shows the learned panel
      if (!e.repeat) this.pressed.add(e.code);
      this.held.add(e.code);
    });
    window.addEventListener('keyup', e => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
    target.addEventListener('mousedown', e => {
      if (!this.locked) {
        target.requestPointerLock();
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
      // Playing: nothing in the page UI (a button just clicked) should keep keyboard focus.
      else (document.activeElement as HTMLElement | null)?.blur();
    });
    document.addEventListener('mousemove', e => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /**
   * Read-and-clear a press. Use for keys handled outside the fixed sim tick (e.g. restart):
   * on high-refresh displays many frames run no tick, so an unconsumed press would repeat.
   */
  consumePressed(code: string): boolean {
    return this.pressed.delete(code);
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
