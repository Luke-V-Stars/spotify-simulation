/**
 * The arithmetic of sharing positions: when this player's position is worth sending,
 * and how other players glide between the updates that arrive.
 */

const SEND_INTERVAL_MS = 100; // at most 10 updates a second
const MIN_MOVE_METRES = 0.02;
const MIN_TURN_RADIANS = 0.02;
/** Matches walking's own easing, so other players move like you do. */
const EASING_PER_SECOND = 12;
const SETTLED = 1e-3;

/** The smallest signed turn from one heading to another. */
export const shortestTurn = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

/** Decides which of this player's poses to send: not too often, and only real changes. */
export class PoseThrottle {
  #last = null;
  #lastSentAt = -Infinity;

  /** Returns the pose if it should be sent now, or null. */
  next(pose, nowMs) {
    if (nowMs - this.#lastSentAt < SEND_INTERVAL_MS) return null;
    const last = this.#last;
    if (
      last &&
      Math.hypot(pose.x - last.x, pose.z - last.z) < MIN_MOVE_METRES &&
      Math.abs(shortestTurn(last.yaw, pose.yaw)) < MIN_TURN_RADIANS
    ) {
      return null;
    }
    this.#last = { ...pose };
    this.#lastSentAt = nowMs;
    return this.#last;
  }

  /** Forgets what was sent, so the next pose goes out, for example after reconnecting. */
  reset() {
    this.#last = null;
    this.#lastSentAt = -Infinity;
  }
}

/**
 * Moves a shown pose part of the way to the latest reported one.
 * @returns {boolean} whether it's still moving
 */
export function easePose(shown, target, deltaSeconds) {
  const remaining = Math.abs(target.x - shown.x) + Math.abs(target.z - shown.z) + Math.abs(shortestTurn(shown.yaw, target.yaw));
  if (remaining < SETTLED) {
    shown.x = target.x;
    shown.z = target.z;
    shown.yaw = target.yaw;
    return false;
  }
  const blend = 1 - Math.exp(-deltaSeconds * EASING_PER_SECOND);
  shown.x += (target.x - shown.x) * blend;
  shown.z += (target.z - shown.z) * blend;
  shown.yaw += shortestTurn(shown.yaw, target.yaw) * blend;
  return true;
}
