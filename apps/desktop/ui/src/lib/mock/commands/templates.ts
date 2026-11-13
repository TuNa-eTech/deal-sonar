// Mock handlers: radar templates.

import type { MockCommandTable } from "./types";
import { TEMPLATES } from "../templates";

export const templateCommands: MockCommandTable = {
  template_list: async () => {
    return structuredClone(TEMPLATES);
  },

  template_get: async (args) => {
    const id = String(args.id ?? "");
    const tpl = TEMPLATES.find((t) => t.id === id);
    if (!tpl) throw new Error(`Không tìm thấy mẫu radar: ${id}`);
    return structuredClone(tpl);
  },
};
