// Mock handlers: data lifecycle (backup, purge, delete).

import type { RadarUpdateResult } from "../../../types/ipc";
import { getRadarDetail } from "./radars";
import type { MockCommandTable } from "./types";
import { invokeMockCommand } from "../index";
import { resetMockBackend, state } from "../store";

export const dataCommands: MockCommandTable = {
  workspace_action: async (args) => {
    const input=(args.input??{}) as Record<string,unknown>;
    if(args.action==="backups")return {paths:["/mock/backups/dealsonar.sqlite3"],pending:false};
    if(args.action==="restore"){if(input.confirm!=="KHOI PHUC")throw new Error("Nhập KHOI PHUC để xác nhận");return {restart_required:true};}
    if(args.action==="restore_cancel")return {cancelled:true};
    if(args.action==="rollback"){
      const d=getRadarDetail(String(input.radar_id));
      if(d.radar.current_version!==input.expected_version)throw new Error("Radar đã thay đổi");
      const v=d.versions.find(v=>v.version===input.version);if(!v)throw new Error("Phiên bản không tồn tại");
      const result=await invokeMockCommand<RadarUpdateResult>("radar_update",{input:{id:d.radar.id,description:v.description,user_profession:v.user_profession,fields:v.fields,match_policy:v.match_policy,confirm_version_upgrade:true}});return result.detail;
    }
    throw new Error("Thao tác không được hỗ trợ");
  },

  data_backup: async () => {
    return {
      path: `~/Library/Application Support/DealSonar/backups/dealsonar-manual-${Date.now()}.db`,
      created_at: Date.now(),
    };
  },

  data_purge: async () => {
    return {
      posts_purged: 38,
      evaluations_cleaned: 38,
    };
  },

  data_delete_all: async (args) => {
    const phrase = String(args.confirm_phrase ?? "").trim();
    if (phrase !== "XOA TOAN BO") {
      throw new Error("Cụm từ xác nhận không khớp.");
    }
    const preservedCalls = state.calls;
    resetMockBackend({ onboarding: true, emptyRadars: true });
    state.calls = preservedCalls;
    return { deleted: true };
  },
};
