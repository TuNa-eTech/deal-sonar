import React,{useEffect,useRef,useState} from "react";
import {api} from "../lib/api";
import {describeChanges,formatVersionTime} from "../lib/versionDiff";
import {offerUndo} from "./UndoCenter";
import type {RadarDetail,PreviewRunState,RadarVersion} from "../types/ipc";
import { Badge, Button } from "./ui";

type Impact={version:number;text:string;flips:{id:string;label:string;nowMatches:boolean}[]};

/** Lịch sử thay đổi của radar: mỗi dòng nói rõ đã đổi gì và cho quay lại bằng một nút (có hoàn tác). */
export function VersionHistory({detail,onChanged}:{detail:RadarDetail;onChanged:()=>void}){
 const [busy,setBusy]=useState<number|null>(null),[message,setMessage]=useState(""),[impact,setImpact]=useState<Impact|null>(null);
 const alive=useRef(true),currentPreview=useRef<PreviewRunState|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=detail.current_version_data,radarId=detail.radar.id;
 const asc=[...detail.versions].sort((a,b)=>a.version-b.version);
 const timeline=[...asc].reverse().map(v=>{const older=asc[asc.indexOf(v)-1];return {v,changes:older?describeChanges(older,v):null,same:describeChanges(v,current).length===0};});

 const preview=async(v:RadarVersion)=>{
  let state=await api.radarPreviewStart({radar_id:radarId,description:v.description,user_profession:v.user_profession,fields:v.fields,match_policy:v.match_policy,source_ids:detail.radar.source_ids});
  for(let i=0;i<600&&["crawling","evaluating"].includes(state.status);i++){
   if(!alive.current){await api.radarPreviewCancel(radarId,state.preview_id);throw new Error("Đã đóng so sánh");}
   await new Promise(r=>setTimeout(r,1000));state=await api.radarPreviewGet(radarId,state.preview_id);
  }
  if(["crawling","evaluating"].includes(state.status))await api.radarPreviewCancel(radarId,state.preview_id);
  if(state.status!=="done")throw new Error(state.error??"Chưa hoàn tất xem thử");return state;
 };

 const showImpact=async(target:RadarVersion)=>{
  setBusy(target.version);setImpact(null);setMessage("Đang đánh giá các bài gần đây…");
  try{
   const a=currentPreview.current??(currentPreview.current=await preview(current));
   const b=await preview(target);
   const before=new Map(a.items.map(i=>[i.post_id,i]));
   const common=b.items.filter(i=>before.has(i.post_id));
   if(!common.length)throw new Error("Chưa có bài chung để so sánh. Hãy thu thập bài rồi thử lại.");
   const flips=common.filter(i=>i.verdict!==before.get(i.post_id)!.verdict).map(i=>({id:i.post_id,label:i.summary||i.post_text.slice(0,80),nowMatches:i.verdict==="match"}));
   const text=flips.length?`Trên ${common.length} bài gần đây, quay lại bản này sẽ đổi kết quả ${flips.length} bài:`:`Trên ${common.length} bài gần đây, quay lại bản này không đổi kết quả bài nào.`;
   if(alive.current){setImpact({version:target.version,text,flips:flips.slice(0,5)});setMessage("Kết quả do AI đánh giá nên có thể lệch nhẹ giữa các lần chạy.");}
  }catch(e){if(alive.current){setMessage(e instanceof Error?e.message:String(e));}}
  finally{if(alive.current)setBusy(null);}
 };

 const rollback=async(target:RadarVersion)=>{
  setBusy(target.version);setMessage("");setImpact(null);
  const previousVersion=current.version,label=formatVersionTime(target.created_at);
  try{
   await api.workspaceAction<RadarDetail>("rollback",{radar_id:radarId,version:target.version,expected_version:previousVersion});
   // Hoàn tác = quay lại chính bản vừa rời đi (lịch sử vẫn còn nguyên).
   offerUndo(`Đã quay lại bản ${label}`,async()=>{
    const latest=await api.radarGet(radarId);
    await api.workspaceAction("rollback",{radar_id:radarId,version:previousVersion,expected_version:latest.radar.current_version});
    onChanged();
   });
   if(alive.current)setMessage(`Đã quay lại bản ${label}. Bấm “Hoàn tác” ở góc màn hình nếu muốn trở về.`);
   onChanged();
  }catch(e){if(alive.current)setMessage(e instanceof Error?e.message:String(e));}
  finally{if(alive.current)setBusy(null);}
 };

 return <section className="card version-history">
  <details>
   <summary><h3 style={{display:"inline"}}>Lịch sử thay đổi</h3> <span className="field-hint">({detail.versions.length} bản)</span></summary>
   <p className="field-hint">Nguồn và kênh thông báo giữ nguyên. Quay lại bản cũ sẽ tạo một bản mới, lịch sử không bị mất và không gửi lại tin cũ.</p>
   <ol className="version-timeline" style={{listStyle:"none",padding:0,margin:0}}>
    {timeline.map(({v,changes,same})=>{
     const isCurrent=v.version===current.version;
     return <li key={v.id} className="version-entry" style={{padding:"var(--space-sm, 8px) 0",borderTop:"1px solid var(--border, rgba(128,128,128,.25))"}}>
      <div className="toolbar-row" style={{display:"flex",gap:"var(--space-sm, 8px)",alignItems:"center",flexWrap:"wrap"}}>
       <strong>{formatVersionTime(v.created_at)}</strong>
       {isCurrent&&<Badge >Hiện tại</Badge>}
       <span style={{flex:1}}/>
       {!isCurrent&&!same&&<>
        <Button size="sm" disabled={busy!==null} onClick={()=>void showImpact(v)}>Xem thử tác động</Button>
        <Button variant="primary" size="sm" disabled={busy!==null} onClick={()=>void rollback(v)}>Quay lại bản này</Button>
       </>}
       {!isCurrent&&same&&<span className="field-hint">Giống bản hiện tại</span>}
      </div>
      {changes===null?<p className="field-hint">Bản đầu tiên</p>
       :changes.length?<ul style={{margin:"4px 0 0",paddingLeft:"1.2em"}}>{changes.map(c=><li key={c}>{c}</li>)}</ul>
       :<p className="field-hint">Chỉ đổi cài đặt khác (nguồn, thông báo…), nội dung radar không đổi.</p>}
      {impact?.version===v.version&&<div role="status" className="version-impact">
       <p>{impact.text}</p>
       {impact.flips.length>0&&<ul>{impact.flips.map(f=><li key={f.id}>{f.nowMatches?"✓ sẽ được nhận":"✗ sẽ bị loại"} · {f.label}</li>)}</ul>}
      </div>}
     </li>;
    })}
   </ol>
   {message&&<p role="status">{message}</p>}
  </details>
 </section>;
}
