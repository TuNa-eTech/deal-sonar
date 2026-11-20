// Gazetteer entry types and builders (port of gazetteer/data.rs helpers).

export interface AdminEntry {
  province: string;
  district: string | null;
  ward: string | null;
  /** Unambiguous folded aliases/names. */
  aliases: readonly string[];
  /** Short abbreviations (`cg`, `tx`, `dd`, `hm`, `lb`, `dn`, ...). */
  shortAliases: readonly string[];
}

export const pOnly = (province: string, aliases: readonly string[], shortAliases: readonly string[] = []): AdminEntry => ({
  province,
  district: null,
  ward: null,
  aliases,
  shortAliases,
});

export const dist = (
  province: string,
  district: string,
  aliases: readonly string[],
  shortAliases: readonly string[] = [],
): AdminEntry => ({ province, district, ward: null, aliases, shortAliases });

export const ward = (province: string, district: string, wardName: string, aliases: readonly string[]): AdminEntry => ({
  province,
  district,
  ward: wardName,
  aliases,
  shortAliases: [],
});
