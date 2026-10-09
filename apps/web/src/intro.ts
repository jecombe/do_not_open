/**
 * The opening curtain a page draws in its own HTML (`#intro`, see vault.html and app.html), so it
 * shows before the bundle has loaded. The page lifts it once it is ready: the curtain plays its
 * opening (the class `is-open`), then leaves the DOM. It plays in full on the first visit of a
 * browser session and only opens, without waiting, on the next ones.
 */
const SEEN = "dno:intro";
/** How long the curtain stays up on a first visit, from the start of navigation. */
const FIRST_MS = 1700;
/** How long the opening plays before the curtain is removed (matches the CSS). */
const OPENING_MS = 1100;

let lifted = false;

function seen(): boolean {
  try {
    return sessionStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}

/** Opens and removes the page's curtain, if it has one; later calls do nothing. */
export function liftIntro(): void {
  if (lifted) return;
  const el = document.getElementById("intro");
  if (!el) return;
  lifted = true;
  const wait = seen() ? 0 : Math.max(0, FIRST_MS - performance.now());
  try {
    sessionStorage.setItem(SEEN, "1");
  } catch {
    // Private windows may refuse storage: the curtain then plays in full every time.
  }
  window.setTimeout(() => {
    el.classList.add("is-open");
    window.setTimeout(() => el.remove(), OPENING_MS);
  }, wait);
}
