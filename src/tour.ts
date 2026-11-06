/**
 * `nowall tour`: a short walkthrough of what nowall does, how to read the notch, and the few
 * commands worth knowing. `setup` ends with the condensed version (`shortTour`).
 */

const REPO = "https://github.com/Vedthakar/nowall";
const IMG = `${REPO}/blob/main/docs/images`;

export const TOUR_LINKS = {
  notch: `${REPO}#the-notch`,
  images: [`${IMG}/notch-tab.png`, `${IMG}/notch-card.png`, `${IMG}/notch-settings.png`],
};

/** Agent colours match the notch: Claude orange, Cursor blue, Codex green, Antigravity violet. */
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  claude: "\x1b[38;5;208m",
  cursor: "\x1b[38;5;75m",
  codex: "\x1b[38;5;78m",
  antigravity: "\x1b[38;5;141m",
  warn: "\x1b[38;5;214m",
  ok: "\x1b[38;5;78m",
  link: "\x1b[4;38;5;75m",
};

export interface TourOptions {
  /** ANSI colours (default: only when stdout is a terminal and NO_COLOR is unset). */
  color?: boolean;
}

export function wantColor(argv: string[] = []): boolean {
  if (argv.includes("--no-color") || process.env.NO_COLOR) return false;
  if (argv.includes("--color")) return true;
  return Boolean(process.stdout.isTTY);
}

type Paint = (style: keyof typeof ANSI, text: string) => string;

function painter(color: boolean): Paint {
  return color ? (style, text) => `${ANSI[style]}${text}${ANSI.reset}` : (_style, text) => text;
}

function legend(p: Paint): string[] {
  return [
    `  ${p("claude", "●●●")} bouncing dots      an agent is working (one glyph per chat, in its agent's colour)`,
    `  ${p("warn", "◯")}   wiggling bubble    it needs your input`,
    `  ${p("cursor", "⇄")}   spinning swap      handing the task to the next agent`,
    `  ${p("ok", "✓")}   check              finished its turn`,
    `  ${p("dim", "◎")}   rings              usage per account: outer = week, inner = short window; orange past 85%`,
    `  ${p("dim", "W")}   letter badge       a second account (Claude Code (work) shows a W)`,
    `  ${p("dim", "×2")}  subagent badge     the chat is running 2 subagents; Done only when all are back`,
  ];
}

/** The full tour: about 40 lines. */
export function tourText(opts: TourOptions = {}): string {
  const p = painter(opts.color ?? false);
  const h = (s: string) => p("bold", s);
  const lines = [
    h("What nowall does"),
    `  You keep working in ${p("claude", "Claude Code")}, ${p("cursor", "Cursor")} or ${p("codex", "Codex")} as usual. A small black notch on the right`,
    "  edge of your screen shows what each chat is doing. When an agent hits its usage limit mid-task,",
    "  nowall checkpoints your files and quietly continues in the next account you are signed in to,",
    "  with the same context. You get one summary when it is done. Everything stays on this computer.",
    "",
    h("How to use it"),
    "  Nothing to do. Hooks cover every git repo you work in.",
    `  ${p("dim", "nowall logs -f")}    watch a background takeover      ${p("dim", "nowall undo [n]")}   roll files back to a step`,
    `  ${p("dim", "nowall status")}     accounts, cooldowns, last session ${p("dim", "nowall demo")}      a simulated failover`,
    "",
    h("The notch"),
    ...legend(p),
    "  Hover it for details: repo, what the agent is doing, who built what, every account's usage.",
    "  Right-click for Settings (takeover order), refresh, hide for an hour, or quit.",
    "",
    h("Accounts"),
    "  More than one subscription? Each extra account is its own login, kept apart from your main one:",
    `  ${p("claude", "nowall account add claude work")}        ${p("codex", "nowall account add codex alt")}`,
    `  ${p("cursor", "nowall account add cursor team --api-key")}   (Cursor allows one login per computer)`,
    `  ${p("dim", "nowall order claude claude:work cursor")}  sets the takeover order.`,
    "",
    h("Desktop app vs terminal"),
    "  Both are covered: the Claude desktop app and terminal Claude Code use the same hooks, so limits",
    "  are caught and tasks continue either way, with nothing to switch on.",
    `  ${p("warn", "One limit:")} the desktop app never reports usage, so its rings stay empty until any terminal`,
    "  `claude` turn fills them in (Claude only shares usage through its status line).",
    "",
    h("Pictures"),
    `  ${p("link", TOUR_LINKS.notch)}`,
    ...TOUR_LINKS.images.map((u) => `  ${p("link", u)}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** What `setup` prints at the end: the legend, the account commands, and where to read more. */
export function shortTour(opts: TourOptions = {}): string {
  const p = painter(opts.color ?? false);
  const lines = [
    p("bold", "The notch, in one glance:"),
    ...legend(p),
    "",
    `Add a second account any time: ${p("claude", "nowall account add claude work")}`,
    "Desktop app and terminal Claude Code are both covered. Usage rings fill in after any terminal `claude` turn.",
    `Run \`${p("bold", "nowall tour")}\` any time for the full walkthrough and screenshots.`,
  ];
  return `${lines.join("\n")}\n`;
}

/** `nowall tour [--no-color|--color]` */
export function runTour(argv: string[]): number {
  process.stdout.write(tourText({ color: wantColor(argv) }));
  return 0;
}
