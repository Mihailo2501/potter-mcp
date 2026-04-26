import { describe, expect, it } from "vitest";
import { byteSize, truncateJson } from "../src/truncation.js";

const sizeOf = (data: unknown) => byteSize(data);

describe("truncateJson", () => {
  it("passes through when under cap", () => {
    const r = truncateJson({ a: 1, b: "hello" }, 20000);
    expect(r.truncated).toBe(false);
    expect(r.final_bytes).toBe(r.original_bytes);
    expect(r.notes).toEqual([]);
  });

  it("truncates a long string", () => {
    const input = "x".repeat(25000);
    const r = truncateJson(input, 20000);
    expect(r.truncated).toBe(true);
    expect(r.final_bytes).toBeLessThanOrEqual(20000);
    expect(r.notes[0]).toContain("string_truncated");
  });

  it("preserves UTF-8 bytes correctly", () => {
    const input = "🌟".repeat(10000);
    const r = truncateJson(input, 20000);
    expect(r.truncated).toBe(true);
    expect(r.final_bytes).toBeLessThanOrEqual(20000);
    expect(typeof r.data).toBe("string");
  });

  it("trims tail of large array", () => {
    const input = Array.from({ length: 500 }, (_, i) => ({ i, note: "y".repeat(150) }));
    const r = truncateJson(input, 20000);
    expect(r.truncated).toBe(true);
    expect(sizeOf(r.data)).toBeLessThanOrEqual(20000);
    expect(Array.isArray(r.data)).toBe(true);
    expect((r.data as unknown[]).length).toBeLessThan(500);
    expect(r.notes[0]).toContain("array_truncated");
  });

  it("shrinks largest string field in an object, stays under cap", () => {
    const input = { meta: "short", blob: "z".repeat(30000), tail: [1, 2, 3] };
    const r = truncateJson(input, 5000);
    expect(r.truncated).toBe(true);
    expect(r.final_bytes).toBeLessThanOrEqual(5000);
    expect(r.data).toHaveProperty("meta", "short");
    expect(r.notes.some((n) => n.startsWith("field_blob"))).toBe(true);
  });

  it("shrinks largest array field in an object", () => {
    const input = {
      summary: "ok",
      items: Array.from({ length: 300 }, (_, i) => ({ i, text: "a".repeat(100) })),
    };
    const r = truncateJson(input, 5000);
    expect(r.truncated).toBe(true);
    expect(r.final_bytes).toBeLessThanOrEqual(5000);
    expect(Array.isArray((r.data as { items: unknown[] }).items)).toBe(true);
  });

  it("handles null and primitives without crashing", () => {
    expect(truncateJson(null, 100).truncated).toBe(false);
    expect(truncateJson(42, 100).truncated).toBe(false);
    expect(truncateJson(true, 100).truncated).toBe(false);
  });
});

describe("byteSize", () => {
  it("counts UTF-8 bytes", () => {
    expect(byteSize("abc")).toBe(5);
    expect(byteSize(null)).toBe(4);
    expect(byteSize({ a: 1 })).toBe(7);
  });
});
