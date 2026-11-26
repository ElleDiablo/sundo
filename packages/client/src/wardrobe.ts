/**
 * The lobby plaza's picker (S2-01): a small HTML panel at the bottom of the screen where I pick a
 * hat and a shirt colour, and where the host presses **Start round**. Plain DOM buttons, like the
 * lobby menu: easier to read, click and reach by keyboard than anything drawn inside Phaser.
 *
 * It only shows while the game is in the lobby phase. The world scene tells it what to show
 * (`show(phase, seconds)`), and it tells the world scene what I picked (`onLook`) or that the host
 * pressed Start (`onStart`). It never talks to the network itself.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │  Waiting for the host to start…               │  ← status (or "Starting in 7…")
 *   │  Hat   [Salakot] [Cap] [Bandana] [No hat]     │
 *   │  Shirt  ■ ■ ■ ■ ■ ■                           │
 *   │                 [Start round]                 │  ← host only
 *   └──────────────────────────────────────────────┘
 */
import type { Phase } from "@sundo/engine";
import { HATS, SHIRTS } from "./looks.ts";
import type { Look } from "./WorldScene.ts";

export interface WardrobeOptions {
  /** True for the host: only the host gets the Start button. */
  readonly isHost: boolean;
  /** My look when the panel opens (my seat's shirt), shown as selected. */
  readonly look: Look;
  /** I picked a new hat or shirt. */
  readonly onLook: (look: Look) => void;
  /** The host pressed Start round. */
  readonly onStart: () => void;
}

export interface Wardrobe {
  /** Shows or hides the panel for this phase, with the countdown (whole seconds) if one runs. */
  show(phase: Phase, countdownSeconds: number | null): void;
}

/** Finds an element by id, or throws: a missing element is a bug in index.html. */
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing from index.html`);
  return found as T;
}

export function setupWardrobe(options: WardrobeOptions): Wardrobe {
  const panel = el<HTMLElement>("wardrobe");
  const status = el<HTMLElement>("wardrobe-status");
  const hats = el<HTMLElement>("hats");
  const shirts = el<HTMLElement>("shirts");
  const startBtn = el<HTMLButtonElement>("start-round");
  let look = options.look;

  /** After a click, hand the keyboard back to the game so WASD walks again straight away. */
  const backToGame = () => document.querySelector<HTMLElement>("#game canvas")?.focus();

  /** Marks the chosen button in a group (aria-pressed: screen readers say "pressed"). */
  const mark = (group: HTMLElement, chosen: number) =>
    group
      .querySelectorAll("button")
      .forEach((b, i) => b.setAttribute("aria-pressed", String(i === chosen)));

  // One button per hat, with its name.
  HATS.forEach((name, hat) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.addEventListener("click", () => {
      look = { ...look, hat };
      mark(hats, hat);
      options.onLook(look);
      backToGame();
    });
    hats.append(button);
  });

  // One colour swatch per shirt; the name is for screen readers and the tooltip.
  SHIRTS.forEach(({ name, hex }, shirt) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.style.background = hex;
    button.title = name;
    button.setAttribute("aria-label", `${name} shirt`);
    button.addEventListener("click", () => {
      look = { ...look, shirt };
      mark(shirts, shirt);
      options.onLook(look);
      backToGame();
    });
    shirts.append(button);
  });

  mark(hats, look.hat);
  mark(shirts, look.shirt);
  startBtn.hidden = !options.isHost;
  startBtn.addEventListener("click", () => {
    startBtn.disabled = true; // one press is enough; the panel closes when the round starts
    options.onStart();
    backToGame();
  });

  return {
    show(phase, seconds) {
      panel.hidden = phase !== "lobby";
      if (phase !== "lobby") return;
      startBtn.disabled = false; // back in the plaza after a round (S2-05): Start works again
      if (seconds !== null) status.textContent = `Room full: starting in ${seconds}…`;
      else if (options.isHost)
        status.textContent = "Pick your look, then start when everyone's here.";
      else status.textContent = "Pick your look. Waiting for the host to start…";
    },
  };
}
