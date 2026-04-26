const TRUNCATION_MARKER = "[…truncated by Potter]";

const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

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
    if (byteLength(JSON.stringify(slice)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, lo);
};

export const truncateJson = (
  data: unknown,
  maxBytes: number,
): TruncationResult<unknown> => {
  const serialized = JSON.stringify(data);
  const originalBytes = byteLength(serialized ?? "null");
  if (originalBytes <= maxBytes) {
    return {
      data,
      truncated: false,
      original_bytes: originalBytes,
      final_bytes: originalBytes,
      notes: [],
    };
  }

  if (typeof data === "string") {
    const jsonOverhead = 2;
    const truncated = truncateString(data, Math.max(maxBytes - jsonOverhead, 0));
    return {
      data: truncated,
      truncated: true,
      original_bytes: originalBytes,
      final_bytes: byteLength(JSON.stringify(truncated)),
      notes: [`string_truncated_from_${originalBytes}_bytes`],
    };
  }

  if (Array.isArray(data)) {
    const truncated = truncateArray(data, maxBytes);
    const finalBytes = byteLength(JSON.stringify(truncated));
    return {
      data: truncated,
      truncated: true,
      original_bytes: originalBytes,
      final_bytes: finalBytes,
      notes: [`array_truncated_from_${data.length}_to_${truncated.length}_items`],
    };
  }

  if (data !== null && typeof data === "object") {
    const trimmed: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    const notes: string[] = [];
    let guard = 0;
    while (byteLength(JSON.stringify(trimmed)) > maxBytes && guard < 64) {
      guard += 1;
      const currentBytes = byteLength(JSON.stringify(trimmed));
      const overshoot = currentBytes - maxBytes;
      let largestKey: string | null = null;
      let largestSize = 0;
      for (const [k, v] of Object.entries(trimmed)) {
        const size = byteLength(JSON.stringify(v) ?? "null");
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
    if (byteLength(JSON.stringify(trimmed)) > maxBytes) {
      const sortedKeys = Object.entries(trimmed)
        .map<[string, number]>(([k, v]) => [k, byteLength(JSON.stringify(v) ?? "null")])
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k);
      for (const key of sortedKeys) {
        if (byteLength(JSON.stringify(trimmed)) <= maxBytes) break;
        delete trimmed[key];
        notes.push(`field_${key}_dropped`);
      }
    }
    let finalBytes = byteLength(JSON.stringify(trimmed));
    if (finalBytes > maxBytes) {
      const marker = { _truncated: true, _note: "response_exceeded_cap" };
      const markerBytes = byteLength(JSON.stringify(marker));
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
    data,
    truncated: true,
    original_bytes: originalBytes,
    final_bytes: originalBytes,
    notes: [`unable_to_truncate_type_${typeof data}`],
  };
};

export const byteSize = (data: unknown): number =>
  byteLength(JSON.stringify(data) ?? "null");
