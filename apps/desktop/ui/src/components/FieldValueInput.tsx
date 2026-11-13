import React from "react";
import type { FieldDef } from "../types/ipc";
import { parseFieldValue } from "../lib/fieldValues";
export function FieldValueInput({field, value, onChange, label, previous}: {field:FieldDef; value:string; onChange:(v:string)=>void; label:string; previous?:unknown}) {
  const id = React.useId();
  if (field.type === "boolean" || field.type === "enum") return <select className="select" aria-label={label} value={value} onChange={e=>onChange(e.target.value)}><option value="">Chưa có thông tin</option>{(field.type === "boolean" ? ["true","false"] : field.options ?? []).map(v=><option key={v} value={v}>{v==="true"?"Có":v==="false"?"Không":v}</option>)}</select>;
  if (field.type === "multi_enum") return <fieldset className="choice-field"><legend>{label}</legend>{(field.options??[]).map(v=><label key={v}><input type="checkbox" checked={value.split(",").map(s=>s.trim()).includes(v)} onChange={e=>{const all=value.split(",").map(s=>s.trim()).filter(Boolean);onChange((e.target.checked?[...all,v]:all.filter(x=>x!==v)).join(", "));}}/>{v}</label>)}</fieldset>;
  if (["money","range","location"].includes(field.type) && value.startsWith("{")) {
    let obj:Record<string,unknown> = {}; try {obj=JSON.parse(value);} catch { /* Show text fallback below. */ }
    if (Object.keys(obj).length) {
      const set=(key:string,v:unknown)=>onChange(JSON.stringify({...obj,[key]:v}));
      if (field.type==="location") return <input className="input" aria-label={label} value={String(obj.raw??"")} onChange={e=>set("raw",e.target.value)}/>;
      return <div className="typed-range"><label>Từ<input className="input" type="number" aria-label={`${label} từ`} value={String(obj.min??"")} onChange={e=>set("min",e.target.value===""?null:Number(e.target.value))}/></label><label>Đến<input className="input" type="number" aria-label={`${label} đến`} value={String(obj.max??"")} onChange={e=>set("max",e.target.value===""?null:Number(e.target.value))}/></label>{field.type==="money"?<><label>Tiền tệ<select className="select" aria-label={`${label} tiền tệ`} value={String(obj.currency??"VND")} onChange={e=>set("currency",e.target.value)}><option>VND</option><option>USD</option></select></label><label>Chu kỳ<select className="select" aria-label={`${label} chu kỳ`} value={String(obj.period??"")} onChange={e=>set("period",e.target.value||null)}><option value="">Một lần</option><option value="month">/ tháng</option><option value="year">/ năm</option><option value="day">/ ngày</option></select></label></>:<input className="input" aria-label={`${label} đơn vị`} value={String(obj.unit??"")} onChange={e=>set("unit",e.target.value)}/>}<button type="button" className="btn btn-sm" onClick={()=>onChange("")}>Nhập lại</button></div>;
    }
  }
  let hint="";
  if (field.type==="money" && value.trim()) {try {const v=parseFieldValue(field,value,previous) as {min:number;max:number;currency:string}; hint=`Sẽ lưu: ${v.min.toLocaleString("vi-VN")} – ${v.max.toLocaleString("vi-VN")} ${v.currency}`;} catch {hint="Ví dụ: 15 triệu/tháng hoặc 12–14 triệu/tháng";}}
  return <div><input id={id} className="input" aria-label={label} type={field.type==="date"?"date":field.type==="url"?"url":field.type==="phone"?"tel":"text"} value={value} onChange={e=>onChange(e.target.value)}/>{hint&&<div className="field-hint" role="status">{hint}</div>}</div>;
}
