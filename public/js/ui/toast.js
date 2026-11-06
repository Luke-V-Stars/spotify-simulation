/** Brief, non-blocking messages. */

const DEFAULT_DURATION_MS = 6000;

const element = document.getElementById('toast');
let hideTimer;

export function showToast(message, durationMs = DEFAULT_DURATION_MS) {
  element.textContent = message;
  element.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    element.hidden = true;
  }, durationMs);
}
