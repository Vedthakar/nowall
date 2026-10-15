import { describe, expect, it } from "vitest";
import { classifyLimit, parseResetTime, zonedToUtc } from "../src/limits.js";

// 2026-10-15 14:00 in Toronto (EDT, UTC-4) = 18:00Z, a Thursday.
const NOW = new Date("2026-10-15T18:00:00Z");
const TZ = "America/Toronto";

describe("parseResetTime: Claude formats", () => {
  it("parses time with IANA zone suffix (real-world format)", () => {
    const d = parseResetTime(
      "You've hit your session limit · resets 5:20pm (America/Toronto)",
      NOW,
    );
    expect(d?.toISOString()).toBe("2026-10-15T21:20:00.000Z");
  });

  it("honours a zone different from the default", () => {
    const d = parseResetTime("resets 6:30pm (America/Edmonton)", NOW, TZ);
    expect(d?.toISOString()).toBe("2026-10-16T00:30:00.000Z");
  });

  it("parses minute-less times", () => {
    const d = parseResetTime("You've hit your session limit · resets 9pm (America/Toronto)", NOW);
    expect(d?.toISOString()).toBe("2026-10-16T01:00:00.000Z");
  });

  it("rolls to tomorrow when the time already passed today", () => {
    const d = parseResetTime("resets 12:40am", NOW, TZ);
    expect(d?.toISOString()).toBe("2026-10-16T04:40:00.000Z");
  });

  it("falls back to default zone when suffix is absent", () => {
    const d = parseResetTime("You've hit your session limit · resets 3:45pm", NOW, TZ);
    expect(d?.toISOString()).toBe("2026-10-15T19:45:00.000Z");
  });

  it("parses weekday resets (weekly limit)", () => {
    const d = parseResetTime("You've hit your weekly limit · resets Mon 12:00am", NOW, TZ);
    expect(d?.toISOString()).toBe("2026-10-19T04:00:00.000Z");
  });

  it("same weekday already past goes to next week", () => {
    const d = parseResetTime("resets Thu 9:00am", NOW, TZ);
    expect(d?.toISOString()).toBe("2026-10-22T13:00:00.000Z");
  });

  it("parses month-day resets", () => {
    const d = parseResetTime("resets Oct 20, 3pm (America/Toronto)", NOW);
    expect(d?.toISOString()).toBe("2026-10-20T19:00:00.000Z");
  });

  it("handles DST transition (resets after fall-back in Toronto)", () => {
    const d = parseResetTime("resets Nov 2, 9am (America/Toronto)", NOW);
    expect(d?.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("handles curly apostrophes", () => {
    const hit = classifyLimit("You’ve hit your session limit · resets 5pm", NOW, TZ);
    expect(hit?.kind).toBe("quota");
  });
});

describe("parseResetTime: Codex and generic formats", () => {
  it("relative days/hours/minutes", () => {
    const d = parseResetTime(
      "You've hit your usage limit. Try again in 1 day 2 hours 5 minutes.",
      NOW,
    );
    expect(d?.toISOString()).toBe("2026-10-16T20:05:00.000Z");
  });

  it("absolute 'try again at' with full date", () => {
    const d = parseResetTime("try again at Oct 17th, 2026 3:05 AM", NOW, TZ);
    expect(d?.toISOString()).toBe("2026-10-17T07:05:00.000Z");
  });

  it("absolute 'try again at' clock only", () => {
    const d = parseResetTime("You've hit your usage limit. Try again at 8:15 PM.", NOW, TZ);
    expect(d?.toISOString()).toBe("2026-10-16T00:15:00.000Z");
  });

  it("seconds", () => {
    const d = parseResetTime("Please retry in 15.5s.", NOW);
    expect(d?.toISOString()).toBe("2026-10-15T18:00:15.500Z");
  });

  it("returns null when there is no time", () => {
    expect(parseResetTime("You've hit your usage limit.", NOW)).toBeNull();
  });
});

describe("classifyLimit", () => {
  const cases: [string, "quota" | "transient", string][] = [
    ["You've hit your session limit · resets 5:20pm (America/Toronto)", "quota", "session"],
    ["You've hit your weekly limit · resets Mon 12:00am", "quota", "weekly"],
    ["You've hit your Opus limit · resets 3:45pm", "quota", "model"],
    ["You've hit your monthly spend limit. Run /usage-credits to manage", "quota", "spend"],
    ["You've hit your org's monthly spend limit", "quota", "spend"],
    ["Credit balance is too low", "quota", "credits"],
    ["API Error: Rate limit reached", "quota", "unknown"],
    ["You've hit your usage limit. Upgrade to Pro or try again in 3 hours.", "quota", "unknown"],
    ["Your workspace is out of credits", "quota", "credits"],
    ["You hit your spend cap", "quota", "spend"],
    ["[API Error: 429 Free allocated quota exceeded.]", "quota", "daily"],
    [
      "API Error: Request rejected (429) · this may be a temporary capacity issue.",
      "transient",
      "per-minute",
    ],
    [
      "API Error: Server is temporarily limiting requests (not your usage limit)",
      "transient",
      "per-minute",
    ],
    ['{"type":"error","error":{"type":"overloaded_error"}}', "transient", "per-minute"],
  ];
  for (const [text, kind, window] of cases) {
    it(`${kind}/${window}: ${text.slice(0, 50)}`, () => {
      const hit = classifyLimit(text, NOW, TZ);
      expect(hit?.kind).toBe(kind);
      expect(hit?.window).toBe(window);
    });
  }

  it("attaches resetsAt when present", () => {
    const hit = classifyLimit(
      "You've hit your session limit · resets 5:20pm (America/Toronto)",
      NOW,
    );
    expect(hit?.resetsAt).toBe("2026-10-15T21:20:00.000Z");
  });

  it("Gemini per-minute quota with short retry is transient", () => {
    const hit = classifyLimit(
      "RESOURCE_EXHAUSTED: Quota exceeded for metric: x, limit: 125000 Please retry in 15.002899939s.",
      NOW,
    );
    expect(hit?.kind).toBe("transient");
  });

  it("Gemini daily quota is a quota hit", () => {
    const hit = classifyLimit("429 RESOURCE_EXHAUSTED Quota exceeded for metric: per_day", NOW);
    expect(hit).toMatchObject({ kind: "quota", window: "daily" });
  });

  it("ignores unrelated errors", () => {
    expect(classifyLimit("Error: ENOENT: no such file or directory", NOW)).toBeNull();
    expect(classifyLimit("API Error: Your computer went to sleep mid-response.", NOW)).toBeNull();
    expect(classifyLimit("authentication_failed", NOW)).toBeNull();
  });
});

describe("zonedToUtc", () => {
  it("converts wall clock to UTC across DST", () => {
    expect(zonedToUtc(2026, 6, 1, 12, 0, TZ).toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(zonedToUtc(2026, 0, 1, 12, 0, TZ).toISOString()).toBe("2026-01-01T17:00:00.000Z");
  });
});
