import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvValues, redact, redactDeep } from "../src/redact.js";

// Fake secrets are assembled at runtime so no secret-shaped literal ever sits in the repo
// (keeps gitleaks clean without allowlists).
const ALPHA = "Q7xk2Lm9Pz4Rt8Vb1Nc6Wd3Ye5Hf0Ja";
const fake = (prefix: string, n: number) =>
  prefix + ALPHA.repeat(Math.ceil(n / ALPHA.length)).slice(0, n);

describe("redact: token patterns", () => {
  const cases: [string, string][] = [
    ["anthropic-key", fake(["sk", "ant", "api03-"].join("-"), 40)],
    ["openai-key", fake(["sk", "proj-"].join("-"), 40)],
    ["github-token", fake("gh" + "p_", 36)],
    ["github-token", fake("github" + "_pat_", 40)],
    ["google-key", fake("AI" + "za", 35)],
    ["aws-key-id", "AK" + "IA" + "Q7XK2LM9PZ4RT8VB"],
    ["slack-token", fake("xo" + "xb-", 24)],
    ["stripe-key", fake("sk" + "_live_", 24)],
    ["npm-token", fake("np" + "m_", 36)],
    ["jwt", `ey${"J"}${fake("", 20)}.ey${"J"}${fake("", 20)}.${fake("", 20)}`],
  ];
  for (const [kind, secret] of cases) {
    it(`strips ${kind}`, () => {
      const out = redact(`before ${secret} after`);
      expect(out).not.toContain(secret);
      expect(out).toContain(`[REDACTED:${kind}]`);
      expect(out).toMatch(/^before .* after$/);
    });
  }

  it("strips bearer tokens but keeps the scheme word", () => {
    const out = redact(`Authorization: Bearer ${fake("", 32)}`);
    expect(out).toContain("Bearer [REDACTED");
    expect(out).not.toContain(fake("", 32));
  });

  it("strips PEM private keys including body", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE",
      " KEY-----\n",
      fake("", 64),
      "\n-----END RSA PRIVATE",
      " KEY-----",
    ].join("");
    const out = redact(`x\n${pem}\ny`);
    expect(out).toBe("x\n[REDACTED:private-key]\ny");
  });

  it("strips truncated PEM blocks", () => {
    const out = redact(`${"-----BEGIN OPENSSH PRIVATE"} KEY-----\n${fake("", 40)}`);
    expect(out).toBe("[REDACTED:private-key]");
  });

  it("strips URL credentials", () => {
    const out = redact(`postgres://admin:${fake("", 12)}@db.local:5432/app`);
    expect(out).toBe("postgres://[REDACTED:url-credentials]@db.local:5432/app");
  });
});

describe("redact: secret-named assignments", () => {
  it.each([
    [`API_KEY=${fake("", 20)}`, "API_KEY=[REDACTED:secret]"],
    [`db_password: "${fake("", 10)}"`, 'db_password: "[REDACTED:secret]"'],
    [`{"client_secret":"${fake("", 16)}"}`, '{"client_secret":"[REDACTED:secret]"}'],
    [`export GITHUB_TOKEN='${fake("", 12)}'`, "export GITHUB_TOKEN='[REDACTED:secret]'"],
  ])("%s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("leaves harmless lookalikes alone", () => {
    for (const s of [
      '"input_tokens": 123456',
      "author: Ved Thakar",
      "max_tokens=4096",
      "const tokenizer = new Tokenizer()",
      "the password field is required",
      "sk-short",
      "skeleton-loader-component",
    ]) {
      expect(redact(s)).toBe(s);
    }
  });
});

describe("redact: options", () => {
  it("strips known env values verbatim", () => {
    const v = `my-${fake("", 10)}`;
    expect(redact(`connecting with ${v}`, { knownValues: [v] })).toBe(
      "connecting with [REDACTED:env-value]",
    );
  });

  it("ignores very short known values", () => {
    expect(redact("abc def", { knownValues: ["abc"] })).toBe("abc def");
  });

  it("emails only when enabled", () => {
    expect(redact("mail jane@example.com")).toBe("mail jane@example.com");
    expect(redact("mail jane@example.com", { emails: true })).toBe("mail [REDACTED:email]");
  });

  it("is idempotent", () => {
    const once = redact(`k=${fake("gh" + "p_", 36)} API_KEY=${fake("", 20)}`);
    expect(redact(once)).toBe(once);
  });
});

describe("redactDeep", () => {
  it("walks objects and arrays", () => {
    const secret = fake("gh" + "p_", 36);
    const out = redactDeep({ a: [secret, 1], b: { c: `x ${secret}` }, d: null });
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.a[1]).toBe(1);
    expect(out.d).toBeNull();
  });
});

describe("loadEnvValues", () => {
  it("reads .env* but not .env.example", () => {
    const dir = mkdtempSync(join(tmpdir(), "nowall-env-"));
    writeFileSync(join(dir, ".env"), `A=${fake("", 12)}\nexport B="${fake("z", 9)}"\nC=1\n`);
    writeFileSync(join(dir, ".env.example"), "D=placeholder-value\n");
    const values = loadEnvValues(dir);
    expect(values).toContain(fake("", 12));
    expect(values).toContain(fake("z", 9));
    expect(values).not.toContain("placeholder-value");
    expect(values).not.toContain("1");
  });
});
