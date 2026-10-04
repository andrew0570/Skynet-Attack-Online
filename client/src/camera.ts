import * as THREE from 'three';
import { clamp, heightAt, raycast, type Arena, type Vec3 } from '@sao/sim';

const SENSITIVITY = 0.0025;
const DISTANCE = 9;
const TARGET_HEIGHT = 1.6;
/** Camera pitch at which dashes go level. Looking higher dashes up; lower dashes down. */
const NEUTRAL_PITCH = 0.35;
const DASH_PITCH_GAIN = 1.4;
/** Gap kept between the camera and any wall it's pulled in front of. */
const WALL_PADDING = 0.4;

/** Third-person orbit camera. yaw = 0 places the camera on +Z looking toward -Z. */
export class ThirdPersonCamera {
  yaw = 0;
  pitch = NEUTRAL_PITCH;
  distance = DISTANCE;
  private target = new THREE.Vector3();
  private currentDistance = DISTANCE;

  constructor(public camera: THREE.PerspectiveCamera) {}

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * SENSITIVITY;
    // Wide range so dashes can aim nearly straight up (look up) or down (look down).
    this.pitch = clamp(this.pitch + dy * SENSITIVITY, -0.9, 1.45);
  }

  /** World-space move direction for WASD axes (forward: +1 = W, right: +1 = D). */
  moveDir(forward: number, right: number): { x: number; z: number } {
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    return { x: -s * forward + c * right, z: -c * forward - s * right };
  }

  /** Dash aim: horizontal camera forward plus elevation derived from camera pitch. */
  aim(): { x: number; z: number; pitch: number } {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw), pitch: (NEUTRAL_PITCH - this.pitch) * DASH_PITCH_GAIN };
  }

  update(player: Vec3, dt: number, arena: Arena, time: number): void {
    const goal = new THREE.Vector3(player.x, player.y + TARGET_HEIGHT, player.z);
    // Snappy follow: fast enough for dashes, smooth enough to hide sim steps.
    this.target.lerp(goal, 1 - Math.exp(-dt * 25));
    if (this.target.distanceToSquared(goal) > 400) this.target.copy(goal);

    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const desired = this.target.clone().addScaledVector(dir, this.distance);

    // Pull in front of walls immediately; ease back out when the view clears.
    const hit = raycast(arena, this.target, desired, time);
    const allowed = hit < 1 ? Math.max(0.3, hit * this.distance - WALL_PADDING) : this.distance;
    this.currentDistance = allowed < this.currentDistance ? allowed : this.currentDistance + (allowed - this.currentDistance) * (1 - Math.exp(-dt * 5));

    const cam = this.camera.position.copy(this.target).addScaledVector(dir, this.currentDistance);
    cam.y = Math.max(cam.y, heightAt(cam.x, cam.z) + 0.6);
    this.camera.lookAt(this.target);
  }
}
