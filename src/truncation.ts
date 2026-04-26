const TRUNCATION_MARKER = "[…truncated by Potter]";

const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

// JSON.stringify throws on circular refs and on BigInt values, which would convert
// a successful tool result into a runtime error. safeStringify swaps both for inert markers
// so the serialization path always produces a string.
export const safeStringify = (data: unknown, indent?: number | string): string => {
  const seen = new WeakSet<object>();
  const out = JSON.stringify(
    data,
    (_key, value) => {
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    },
    indent,
  );
  return out ?? "null";
};

const sizeOf = (data: unknown): number => byteLength(safeStringify(data));

export interface TruncationResult<T> {
  data: T;
  truncated: boolean;
  original_bytes: number;
  final_bytes: number;
  notes: string[];
}

const truncateString = (value: string, maxBytes: number): string => {
  if (byteLength(value) <= maxBytes) return value;
  const markerBytes = byteLength(TRUNCATION_MARKER);
  const targetBytes = Math.max(maxBytes - markerBytes, 0);
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (byteLength(value.slice(0, mid)) <= targetBytes) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, lo) + TRUNCATION_MARKER;
};

const truncateArray = <T>(value: T[], maxBytes: number): T[] => {
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const slice = value.slice(0, mid);
    if (sizeOf(slice) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, lo);
};

export const truncateJson = (
  data: unknown,
  maxBytes: number,
): TruncationResult<unknown> => {
  // Normalize the input through safeStringify -> JSON.parse to break circular refs
  // and convert BigInts to strings up front. The recursive size-driven traversal below
  // assumes a tree-shaped object; without this normalization, an oversized circular
  // payload sends the recursion into a stack overflow before reaching any fallback.
  let normalized: unknown = data;
  try {
    normalized = JSON.parse(safeStringify(data));
  } catch {
    // safeStringify shouldn't throw, but if JSON.parse somehow does, fall back to the
    // original input — the recursive walk below will still degrade gracefully.
  }
  const serialized = safeStringify(normalized);
  const originalBytes = byteLength(serialized);
  if (originalBytes <= maxBytes) {
    return {
      data: normalized,
      truncated: false,
      original_bytes: originalBytes,
      final_bytes: originalBytes,
      notes: [],
    };
  }

  if (typeof normalized === "string") {
    const jsonOverhead = 2;
    const truncated = truncateString(normalized, Math.max(maxBytes - jsonOverhead, 0));
    return {
      data: truncated,
      truncated: true,
      original_bytes: originalBytes,
      final_bytes: sizeOf(truncated),
      notes: [`string_truncated_from_${originalBytes}_bytes`],
    };
  }

  if (Array.isArray(normalized)) {
    const truncated = truncateArray(normalized, maxBytes);
    const finalBytes = sizeOf(truncated);
    return {
      data: truncated,
      truncated: true,
      original_bytes: originalBytes,
      final_bytes: finalBytes,
      notes: [`array_truncated_from_${normalized.length}_to_${truncated.length}_items`],
    };
  }

  if (normalized !== null && typeof normalized === "object") {
    const trimmed: Record<string, unknown> = { ...(normalized as Record<string, unknown>) };
    const notes: string[] = [];
    let guard = 0;
    while (sizeOf(trimmed) > maxBytes && guard < 64) {
      guard += 1;
      const currentBytes = sizeOf(trimmed);
      const overshoot = currentBytes - maxBytes;
      let largestKey: string | null = null;
      let largestSize = 0;
      for (const [k, v] of Object.entries(trimmed)) {
        const size = sizeOf(v);
        if (size > largestSize) {
          largestSize = size;
          largestKey = k;
        }
      }
      if (largestKey === null) break;
      const value = trimmed[largestKey];
      if (typeof value === "string") {
        const next = truncateString(value, Math.max(largestSize - overshoot - 16, 16));
        if (next === value) break;
        trimmed[largestKey] = next;
        notes.push(`field_${largestKey}_string_truncated`);
      } else if (Array.isArray(value)) {
        const next = truncateArray(value, Math.max(largestSize - overshoot - 16, 16));
        if (next.length === value.length) break;
        trimmed[largestKey] = next;
        notes.push(`field_${largestKey}_array_truncated_from_${value.length}_to_${next.length}`);
      } else if (value !== null && typeof value === "object") {
        const targetForSubtree = Math.max(largestSize - overshoot - 32, 256);
        const sub = truncateJson(value, targetForSubtree);
        if (!sub.truncated) break;
        trimmed[largestKey] = sub.data;
        notes.push(`field_${largestKey}_subtree_truncated`);
      } else {
        notes.push(`field_${largestKey}_dropped`);
        delete trimmed[largestKey];
      }
    }
    if (sizeOf(trimmed) > maxBytes) {
      const sortedKeys = Object.entries(trimmed)
        .map<[string, number]>(([k, v]) => [k, sizeOf(v)])
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k);
      for (const key of sortedKeys) {
        if (sizeOf(trimmed) <= maxBytes) break;
        delete trimmed[key];
        notes.push(`field_${key}_dropped`);
      }
    }
    let finalBytes = sizeOf(trimmed);
    if (finalBytes > maxBytes) {
      const marker = { _truncated: true, _note: "response_exceeded_cap" };
      const markerBytes = sizeOf(marker);
      if (markerBytes <= maxBytes) {
        return {
          data: marker,
          truncated: true,
          original_bytes: originalBytes,
          final_bytes: markerBytes,
          notes: [...notes, "fallback_marker_used"],
        };
      }
    }
    return {
      data: trimmed,
      truncated: true,
      original_bytes: originalBytes,
      final_bytes: finalBytes,
      notes,
    };
  }

  return {
    data: normalized,
    truncated: true,
    original_bytes: originalBytes,
    final_bytes: originalBytes,
    notes: [`unable_to_truncate_type_${typeof normalized}`],
  };
};

export const byteSize = (data: unknown): number => sizeOf(data);
