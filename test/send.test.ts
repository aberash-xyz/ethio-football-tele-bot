import { describe, expect, test } from "bun:test";
import { chunkMessage } from "../src/send.ts";

describe("chunkMessage", () => {
  test("short text is one chunk", () => {
    expect(chunkMessage("hello\nworld")).toEqual(["hello\nworld"]);
  });

  test("splits at newlines, never exceeds limit, loses nothing", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"ኢትዮጵያ ".repeat(10)}`);
    const text = lines.join("\n");
    const chunks = chunkMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join("\n")).toBe(text);
    for (const c of chunks) expect(c.startsWith("line ")).toBe(true); // split only at line boundaries
  });

  test("hard-splits a single overlong line", () => {
    const chunks = chunkMessage("X".repeat(1050), 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 50]);
  });

  test("empty input yields no chunks", () => {
    expect(chunkMessage("")).toEqual([]);
  });
});
