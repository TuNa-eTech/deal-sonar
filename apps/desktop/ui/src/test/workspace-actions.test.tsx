import React from "react";
import {render,screen,waitFor,act} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {describe,it,expect,afterEach} from "vitest";
import {BackupRestore} from "../components/BackupRestore";
import {VersionHistory} from "../components/VersionHistory";
import {UndoCenter,offerUndo,clearUndo} from "../components/UndoCenter";
import {api} from "../lib/api";
import {getMockCommandCalls} from "../lib/mockBackend";
afterEach(()=>act(()=>clearUndo()));
describe("Workspace recovery actions",()=>{
 it("requires exact confirmation and allows cancelling staged restoration",async()=>{
  const user=userEvent.setup();render(<BackupRestore/>);
  await user.type(screen.getByLabelText("Đường dẫn bản sao lưu"),"/mock/backups/dealsonar.sqlite3");
  expect(screen.getByRole("button",{name:"Chuẩn bị khôi phục khi mở lại"})).toBeDisabled();
  await user.type(screen.getByLabelText("Xác nhận khôi phục"),"KHOI PHUC");
  await user.click(screen.getByRole("button",{name:"Chuẩn bị khôi phục khi mở lại"}));
  await user.click(await screen.findByRole("button",{name:"Hủy khôi phục đã lên lịch"}));
  expect(await screen.findByText(/Đã hủy khôi phục/)).toBeInTheDocument();
  expect(getMockCommandCalls().some(c=>c.cmd==="workspace_action"&&c.args.action==="restore_cancel")).toBe(true);
 });
 it("publishes a selected historical definition and rejects stale versions",async()=>{
  const list=await api.radarList();const id=list[0]!.id;const before=await api.radarGet(id);
  await api.radarUpdate({id,description:"Updated target",confirm_version_upgrade:true});
  const current=await api.radarGet(id);const user=userEvent.setup();render(<VersionHistory detail={current} onChanged={()=>{}}/>);
  await user.selectOptions(screen.getByLabelText("Phiên bản đối chiếu"),String(before.radar.current_version));
  await user.click(screen.getByRole("checkbox"));await user.click(screen.getByRole("button",{name:"Quay lại định nghĩa đã chọn"}));
  await screen.findByText(/Đã áp dụng thành/);
  expect((await api.radarGet(id)).current_version_data.description).toBe(before.current_version_data.description);
  await expect(api.workspaceAction("rollback",{radar_id:id,version:before.radar.current_version,expected_version:current.radar.current_version})).rejects.toThrow();
 });
 it("keeps undo pending on failure and permits a retry",async()=>{
  let calls=0;offerUndo("Test",async()=>{calls++;if(calls===1)throw new Error("Retry me");});
  const user=userEvent.setup();render(<UndoCenter/>);await user.click(screen.getByRole("button",{name:"Hoàn tác"}));await screen.findByRole("alert");await user.click(screen.getByRole("button",{name:"Hoàn tác"}));await waitFor(()=>expect(screen.queryByText("Test")).not.toBeInTheDocument());expect(calls).toBe(2);
 });
});
