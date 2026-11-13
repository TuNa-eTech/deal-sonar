import React,{useEffect,useState} from "react";
import {api} from "../lib/api";
import type {FunnelStats,HealthStatus,Source,CrawlRun} from "../types/ipc";
import {formatRelativeTime} from "../lib/format";
export function PipelineDiagnosis({health,onRefresh}:{health:HealthStatus|null;onRefresh:()=>Promise<void>}){
 const [sources,setSources]=useState<Source[]>([]),[stats,setStats]=useState<FunnelStats|null>(null),[runs,setRuns]=useState<CrawlRun[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const load=async()=>{setBusy(true);try{await onRefresh();const [s,f,r]=await Promise.all([api.sourceList(),api.radarStats(null,7),api.crawlRunList(null,30)]);setSources(s);setStats(f);setRuns(r);setError("");}catch(e){setError(String(e));}finally{setBusy(false);}};
 useEffect(()=>{void load();},[]);
 const followed=sources.filter(s=>s.followed),failed=followed.filter(s=>s.state!=="ok");
 const stages=[
  ["1. Nguồn",`${followed.length} nhóm đang theo dõi; ${failed.length} nhóm lỗi`,!followed.length?"Theo dõi nhóm trong Nguồn.":failed.length?"Mở Nguồn để xử lý nhóm không truy cập được.":"Nguồn đã được chọn."],
  ["2. Thu thập",!health?.extension_connected?"Chưa kết nối Chrome":health.crawl_paused?"Đang tạm dừng":health.automatic_scanning===false?"Chỉ quét thủ công":health.automatic_scanning==null?"Chưa rõ chế độ quét":"Đã bật tự động",health?.last_crawl_at?`Lần thành công ${formatRelativeTime(health.last_crawl_at)}. ${runs.filter(r=>r.status==="error"||r.status==="blocked").length} lần lỗi trong 30 lượt gần nhất.`:"Chưa có lượt thành công; mở tiện ích và thử quét một nhóm."],
  ["3. Tiếp nhận & Lọc",stats?`${stats.posts_captured} bài tiếp nhận trong 7 ngày`:"Chưa có dữ liệu",stats?`${stats.dedup_dropped} trùng; ${stats.prefilter_dropped} bị lọc sơ bộ. Kiểm tra bài bị loại trong Cơ hội nếu nghi bỏ sót.`:"Chạy lại kiểm tra."],
  ["4. Đánh giá",`${health?.pending_ai_posts??0} bài chờ AI`,health?.ai_state==="error"?"Kiểm tra AI hoặc cấu hình lại trong Cài đặt.":stats?`${stats.rule_decided} bài do bộ luật; ${stats.ai_decided} bài do AI trong 7 ngày.`:"Chưa có số liệu."],
  ["5. Cơ hội",`${stats?.leads_created??0} cơ hội tạo trong 7 ngày`,`${stats?.leads_weak??0} khớp yếu. Nếu không thấy tin, xóa bộ lọc và bật hiển thị cơ hội cần xem thêm.`],
  ["6. Giao thông báo",`${health?.outbox_pending??0} chờ gửi; ${health?.outbox_failed??0} lỗi`,health?.telegram_state==="error"?"Kết nối lại Telegram trong Cài đặt.":`${stats?.leads_notified??0} cơ hội đã ghi nhận thông báo trong 7 ngày. Kiểm tra kênh và giờ yên lặng theo radar.`],
 ];
 return <section className="card"><header className="screen-header"><div><h2>Vì sao chưa có tin mới?</h2><p>Số liệu toàn ứng dụng; phễu 7 ngày và các lượt quét gần nhất không phải cùng một phiên quét.</p></div><button className="btn" disabled={busy} onClick={()=>void load()}>Chẩn đoán lại</button></header>{error&&<p role="alert">{error}</p>}<ol className="diagnosis-stages">{stages.map(([name,value,hint])=><li key={name}><strong>{name}</strong><p>{value}</p><small>{hint}</small><p><button className="btn btn-sm" onClick={()=>{location.hash=name?.startsWith("1.")?"sources":name?.startsWith("3.")||name?.startsWith("5.")?"inbox":name?.startsWith("6.")||name?.startsWith("4.")?"settings":"health";}}>Mở nơi xử lý</button></p>{name?.startsWith("2.")&&<p className="field-hint">Bài trong hàng đợi tiện ích chưa đồng bộ chỉ xem được trong tiện ích Chrome; Desktop chưa có số đếm này.</p>}</li>)}</ol></section>;
}
