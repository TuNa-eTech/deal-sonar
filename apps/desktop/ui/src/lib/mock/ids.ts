// Deterministic ULID-like id generator for mock records.

let ulidSeq = 1000;
export function nextId(prefix = "01JCF"): string {
  ulidSeq += 1;
  return `${prefix}${String(ulidSeq).padStart(26-prefix.length, "0")}`;
}
