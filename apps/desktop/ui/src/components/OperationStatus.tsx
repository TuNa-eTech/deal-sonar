import React from "react";
import type {HealthStatus, Radar, Source} from "../types/ipc";
import {formatRelativeTime,formatExactTime} from "../lib/format";
export function operationState(health:HealthStatus|null):{label:string;detail:string;tone:string} {
 if(!health?.extension_connected)return {label:"Chờ Chrome",detail:"Mở Chrome có tiện ích DealSonar để nhận bài mới.",tone:"warning"};
 if(health.facebook_session!=="ok")return {label:"Cần kiểm tra Facebook",detail:"Đăng nhập hoặc hoàn thành xác minh trong Chrome.",tone:"danger"};
 if(health.crawl_paused)return {label:"Đã tạm dừng thu thập",detail:"Kiểm tra lý do dừng và tiếp tục trong Kết nối hoặc tiện ích Chrome.",tone:"warning"};
 if(health.automatic_scanning==null)return {label:"Chưa xác nhận chế độ quét",detail:"Mở tiện ích Chrome hoặc cập nhật tiện ích để đồng bộ trạng thái.",tone:"warning"};
 if(!health.automatic_scanning)return {label:"Chỉ quét thủ công",detail:"Bật Quét tự động trong tiện ích Chrome để quét theo lịch.",tone:"info"};
 if(health.ai_state!=="ok"&&health.ai_state!=="not_configured")return {label:"Đang chờ AI",detail:`${health.pending_ai_posts} bài đang chờ xử lý. Nguồn vẫn có thể tiếp tục thu thập.`,tone:"warning"};
 return {label:health.next_crawl_at?"Đã bật lịch thu thập":"Chờ lịch từ nguồn",detail:health.next_crawl_at?`Lượt kế tiếp dự kiến ${formatExactTime(health.next_crawl_at)}`:"Kiểm tra nguồn đang theo dõi và giờ hoạt động.",tone:"info"};
}
export function OperationStatus({health,radars,sources,onDiagnose}:{health:HealthStatus|null;radars?:Radar[];sources?:Source[];onDiagnose?:()=>void}) {
 const state=operationState(health);
 return <div className={`operation-status ${state.tone}`}><div><strong>{state.label}</strong><p>{state.detail}</p><div className="operation-facts"><small>{health?.last_crawl_at?`Quét thành công ${formatRelativeTime(health.last_crawl_at)}`:"Chưa có lần quét thành công được ghi nhận"}</small>{radars&&<small>{radars.filter(r=>r.status==="active").length} radar đã bật</small>}{sources&&<small>{sources.filter(s=>s.followed).length} nhóm đang theo dõi</small>}</div></div>{onDiagnose&&<button className="btn btn-sm" onClick={onDiagnose}>Kiểm tra kết nối</button>}</div>;
}
