/**
 * The end-of-round screen (S2-05): a small HTML panel in the middle of the screen when the round
 * is won (every child home) or lost (dawn came first), with the team score worked out line by line.
 * The host gets a "Back to the plaza" button; guests wait for the host. Like the wardrobe, it never
 * talks to the network: the world scene says what to show, and the button calls `onAgain`.
 *
 *   ┌───────────────────────────────────────┐
 *   │        Nakauwi na sila!                │  ← "They're home!" (or "Dawn came")
 *   │   All 5 children are home.             │
 *   │   Children home     5 × 100 =  500     │
 *   │   Seconds left    102 ×   2 =  204     │
 *   │   Times lost        0 × −25 =    0     │
 *   │   Team score                   704     │
 *   │         [Back to the plaza]            │  ← host only
 *   └───────────────────────────────────────┘
 */
import { SCORE_PER_KID, SCORE_PER_SECOND, SCORE_PER_TIME_LOST } from "@sundo/engine";
import type { RoundInfo } from "./WorldScene.ts";

export interface ResultOptions {
  /** True for the host: only the host can take everyone back to the plaza. */
  readonly isHost: boolean;
  /** The host pressed "Back to the plaza". */
  readonly onAgain: () => void;
}

export interface Result {
  /** Shows the panel for a finished round ("won" / "lost"); hides it for any other phase. */
  show(info: RoundInfo): void;
}

/** Finds an element by id, or throws: a missing element is a bug in index.html. */
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing from index.html`);
  return found as T;
}

export function setupResult(options: ResultOptions): Result {
  const panel = el<HTMLElement>("result");
  const title = el<HTMLElement>("result-title");
  const summary = el<HTMLElement>("result-summary");
  const lines = el<HTMLElement>("result-lines");
  const again = el<HTMLButtonElement>("again");
  const waiting = el<HTMLElement>("result-waiting");

  again.hidden = !options.isHost;
  waiting.hidden = options.isHost;
  again.addEventListener("click", () => {
    again.disabled = true; // one press is enough; the panel closes when the lobby comes back
    options.onAgain();
    document.querySelector<HTMLElement>("#game canvas")?.focus(); // WASD walks again at once
  });

  /** One row of the score table: label, the sum, and its result (right-aligned by CSS). */
  const row = (label: string, sum: string, value: number) => {
    const tr = document.createElement("tr");
    for (const text of [label, sum, String(value)]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  };

  return {
    show(info) {
      const ended = info.phase === "won" || info.phase === "lost";
      panel.hidden = !ended;
      if (!ended) {
        again.disabled = false; // ready for the next round's end
        return;
      }
      const won = info.phase === "won";
      title.textContent = won ? "Nakauwi na sila!" : "Dawn came.";
      summary.textContent = won
        ? `All ${info.total} children are home.`
        : `${info.home} of ${info.total} children made it home before dawn.`;
      lines.replaceChildren(
        row("Children home", `${info.home} × ${SCORE_PER_KID}`, info.home * SCORE_PER_KID),
        row(
          "Seconds left",
          `${info.secondsLeft} × ${SCORE_PER_SECOND}`,
          info.secondsLeft * SCORE_PER_SECOND,
        ),
        row(
          "Times lost",
          `${info.timesLost} × −${SCORE_PER_TIME_LOST}`,
          -info.timesLost * SCORE_PER_TIME_LOST,
        ),
        row("Team score", "", info.score),
      );
    },
  };
}
