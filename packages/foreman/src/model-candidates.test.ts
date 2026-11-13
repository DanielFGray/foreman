import { describe, expect, test } from "bun:test";
import type { Catalog } from "./model-advice-catalog.ts";
import { candidatesFrom } from "./model-candidates.ts";

const catalog: Catalog = {
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-a": { name: "Claude A", tool_call: true },
      "claude-old": { name: "Old", tool_call: true, status: "deprecated" },
      "claude-chat": { name: "Chat only", tool_call: false },
    },
  },
  "opencode-go": { name: "OpenCode Go", models: { "kimi-k3": { name: "Kimi", tool_call: true } } },
  google: { name: "Google", models: { gemini: { name: "Gemini", tool_call: true } } },
};

describe("candidatesFrom", () => {
  test("claude takes the bare id, opencode the provider-qualified one", () => {
    const found = candidatesFrom(
      catalog,
      [
        { harness: "claude", catalogProvider: "anthropic" },
        { harness: "opencode", catalogProvider: "opencode-go" },
      ],
      new Set(),
    );
    expect(found.map((one) => [one.harness, one.model, one.pool])).toEqual([
      ["claude", "claude-a", "Anthropic"],
      ["opencode", "opencode-go/kimi-k3", "OpenCode Go"],
    ]);
  });

  test("a provider with no login offers nothing", () => {
    expect(candidatesFrom(catalog, [], new Set())).toEqual([]);
  });

  test("a model the registry lists is not offered again", () => {
    const found = candidatesFrom(
      catalog,
      [{ harness: "claude", catalogProvider: "anthropic" }],
      new Set(["claude-a"]),
    );
    expect(found).toEqual([]);
  });

  test("codex bills the registry's openai-codex account", () => {
    const openai: Catalog = { openai: { name: "OpenAI", models: { g: { tool_call: true } } } };
    const [one] = candidatesFrom(
      openai,
      [{ harness: "codex", catalogProvider: "openai" }],
      new Set(),
    );
    expect([one?.provider, one?.modelsDev, one?.name]).toEqual(["openai-codex", "openai/g", "g"]);
  });
});
