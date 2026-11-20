import type {AuthorRole,FilterOperator,HardFilter,RadarVersion,WantIntent} from "../types/ipc";

const INTENT:Record<WantIntent,string>={demand:"người đang cần mua/tìm",supply:"người đang bán/cung cấp",any:"cả hai phía"};
const ROLE:Record<AuthorRole,string>={end_user:"người dùng cuối",peer:"đồng nghiệp/môi giới",unknown:"không rõ"};
const OP:Record<FilterOperator,string>={eq:"=",ne:"≠",in:"thuộc",lt:"<",lte:"≤",gt:">",gte:"≥",between:"trong khoảng",contains:"chứa",is_empty:"để trống"};

const clip=(s:string,n=40)=>s.length>n?`${s.slice(0,n-1)}…`:s;
const show=(v:unknown):string=>{
 if(v===undefined||v===null||v==="")return "";
 if(Array.isArray(v))return v.map(show).join(" – ");
 if(typeof v==="object")return clip(JSON.stringify(v));
 return typeof v==="number"?v.toLocaleString("vi-VN"):String(v);
};

/** Câu mô tả một điều kiện lọc, ví dụ "Giá ≤ 5.000.000". */
export function describeFilter(f:HardFilter,labels:Map<string,string>):string{
 const name=labels.get(f.field)??f.field;const value=show(f.value);
 return `${name} ${OP[f.op]??f.op}${value?` ${value}`:""}`.trim();
}

const filterKey=(f:HardFilter)=>JSON.stringify([f.field,f.op,f.value??null,f.when_missing]);

/**
 * Liệt kê bằng tiếng Việt những gì khác nhau giữa `prev` và `next`.
 * Mảng rỗng nghĩa là hai phiên bản có cùng định nghĩa.
 */
export function describeChanges(prev:RadarVersion,next:RadarVersion):string[]{
 const out:string[]=[];
 if(prev.description!==next.description)out.push(`Mục tiêu: “${clip(prev.description)}” → “${clip(next.description)}”`);
 if((prev.user_profession??"")!==(next.user_profession??""))out.push(`Nghề nghiệp: “${prev.user_profession??"(trống)"}” → “${next.user_profession??"(trống)"}”`);

 const before=new Map(prev.fields.map(f=>[f.key,f])),after=new Map(next.fields.map(f=>[f.key,f]));
 for(const f of next.fields)if(!before.has(f.key))out.push(`Thêm thông tin cần lấy: ${f.label}`);
 for(const f of prev.fields)if(!after.has(f.key))out.push(`Bỏ thông tin cần lấy: ${f.label}`);
 for(const f of next.fields){
  const old=before.get(f.key);if(!old)continue;
  if(old.label!==f.label)out.push(`Đổi tên “${old.label}” → “${f.label}”`);
  else if(old.type!==f.type||old.required!==f.required||old.description!==f.description||JSON.stringify(old.options)!==JSON.stringify(f.options))out.push(`Chỉnh thông tin cần lấy: ${f.label}`);
 }

 const a=prev.match_policy,b=next.match_policy;
 if(a.want_intent!==b.want_intent)out.push(`Đối tượng: ${INTENT[a.want_intent]} → ${INTENT[b.want_intent]}`);
 const roleAdded=b.exclude_roles.filter(r=>!a.exclude_roles.includes(r)),roleRemoved=a.exclude_roles.filter(r=>!b.exclude_roles.includes(r));
 if(roleAdded.length)out.push(`Loại thêm: ${roleAdded.map(r=>ROLE[r]).join(", ")}`);
 if(roleRemoved.length)out.push(`Không còn loại: ${roleRemoved.map(r=>ROLE[r]).join(", ")}`);

 const labels=new Map<string,string>([...prev.fields,...next.fields].map(f=>[f.key,f.label]));
 const oldF=new Map(a.hard_filters.map(f=>[filterKey(f),f])),newF=new Map(b.hard_filters.map(f=>[filterKey(f),f]));
 const added=b.hard_filters.filter(f=>!oldF.has(filterKey(f))),removed=a.hard_filters.filter(f=>!newF.has(filterKey(f)));
 // Cùng trường nhưng đổi giá trị thì gộp thành một dòng "→" cho dễ đọc.
 const used=new Set<HardFilter>();
 for(const n of added){
  const o=removed.find(r=>r.field===n.field&&!used.has(r));
  if(o){used.add(o);out.push(`Điều kiện: ${describeFilter(o,labels)} → ${describeFilter(n,labels)}`);}
  else out.push(`Thêm điều kiện: ${describeFilter(n,labels)}`);
 }
 for(const o of removed)if(!used.has(o))out.push(`Bỏ điều kiện: ${describeFilter(o,labels)}`);
 return out;
}

/** "Hôm nay 14:20", "Hôm qua 09:05" hoặc "12/11/2026 09:05". */
export function formatVersionTime(ms:number,now=Date.now()):string{
 const d=new Date(ms),n=new Date(now);
 const time=d.toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"});
 const day=(x:Date)=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();
 const diff=Math.round((day(n)-day(d))/86_400_000);
 if(diff===0)return `Hôm nay ${time}`;
 if(diff===1)return `Hôm qua ${time}`;
 return `${d.toLocaleDateString("vi-VN")} ${time}`;
}
