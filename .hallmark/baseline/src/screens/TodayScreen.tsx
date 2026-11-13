import React,{useEffect,useRef,useState} from "react";
import {api} from "../lib/api";
import type {HealthStatus,Lead,Radar,Source} from "../types/ipc";
import {formatExactTime} from "../lib/format";
import {LeadDetailPanel} from "../components/LeadDetailPanel";
import {OperationStatus} from "../components/OperationStatus";
export function TodayScreen({health,radars,sources,refreshToken,onOpenOpportunities,onCreateRadar,onDiagnose,onUpdated}:{health:HealthStatus|null;radars:Radar[];sources:Source[];refreshToken:number;onOpenOpportunities:()=>void;onCreateRadar:()=>void;onDiagnose:()=>void;onUpdated:()=>void}) {
 const [leads,setLeads]=useState<Lead[]>([]),[total,setTotal]=useState(0),[unread,setUnread]=useState(0),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[page,setPage]=useState<string|null>(null),[next,setNext]=useState<string|null>(null),[tick,setTick]=useState(0);
 const sequence=useRef(0);
 useEffect(()=>{const timer=setInterval(()=>setTick(t=>t+1),60000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{const seq=++sequence.current;const end=new Date();end.setHours(23,59,59,999);void Promise.all([api.leadList({follow_up_before:end.getTime(),include_weak:true,limit:50,cursor:page}),api.leadList({unread_only:true,include_weak:true,limit:1})]).then(([due,newItems])=>{if(seq!==sequence.current)return;setLeads(due.items);setTotal(due.total);setNext(due.next_cursor);setUnread(newItems.total);setError(null);}).catch(e=>setError(String(e)));return()=>{sequence.current++;};},[refreshToken,tick,page]);
 return (
  <div className="today-screen">
   <header className="screen-header"><div><span className="eyebrow">KHÔNG GIAN LÀM VIỆC</span><h1 className="screen-title">Hôm nay</h1><p className="screen-subtitle">Ưu tiên cơ hội mới và những cuộc liên hệ bạn đã hẹn.</p></div><button className="btn btn-primary" onClick={onCreateRadar}>+ Tạo radar</button></header>
   <OperationStatus health={health} radars={radars} sources={sources} onDiagnose={onDiagnose}/>
   <div className="today-summary">
    <button className="summary-card" onClick={onOpenOpportunities}><strong>{unread}</strong><span>Cơ hội chưa đọc</span><small>Mở danh sách cơ hội →</small></button>
    <div className="summary-card"><strong>{total}</strong><span>Việc đến hạn hôm nay và quá hạn</span><small>Lịch được giữ khi đóng ứng dụng</small></div>
   </div>
   {error && <div role="alert">{error}<button className="btn" onClick={()=>setTick(t=>t+1)}>Thử lại</button></div>}
   <section className="card"><h2>Liên hệ cần thực hiện</h2><p className="field-hint">Hoàn tất hoặc đặt lịch mới sau khi trao đổi. Nếu máy tắt, nhắc việc quá hạn được xử lý khi mở lại DealSonar.</p>
    {leads.length===0 ? (
     <div className="empty-state"><strong>Không có lịch liên hệ đến hạn.</strong><p>Mở một cơ hội, ghi chú và đặt lịch cho lần trao đổi tiếp theo.</p><button className="btn btn-primary" onClick={onOpenOpportunities}>Xem cơ hội</button></div>
    ) : leads.map(lead=>(
     <button key={lead.id} className="task-row" onClick={()=>setSelected(lead.id)}>
      <span className={`badge ${lead.follow_up_at!<Date.now()?"badge-warning":""}`}>{formatExactTime(lead.follow_up_at!)}</span>
      <span><strong>{lead.summary}</strong><small>{lead.author_name} · {lead.radar_name}</small></span><span>Mở →</span>
     </button>
    ))}
    <div className="pagination"><button className="btn btn-sm" disabled={!page} onClick={()=>setPage(null)}>Về trang đầu</button><button className="btn btn-sm" disabled={!next} onClick={()=>setPage(next)}>Trang tiếp</button></div>
   </section>
   {selected && (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Xử lý việc liên hệ"><div className="modal-panel"><div className="modal-body"><LeadDetailPanel key={selected} leadId={selected} onClose={()=>setSelected(null)} onUpdated={()=>{setTick(t=>t+1);onUpdated();}}/></div></div></div>
   )}
  </div>
 );
}
