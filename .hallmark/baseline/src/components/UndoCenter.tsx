import React,{useEffect,useState} from "react";
type Undo={id:number;label:string;run:()=>Promise<void>};
let actions:Undo[]=[];let serial=0;const listeners=new Set<()=>void>();
const emit=()=>listeners.forEach(fn=>fn());
export function clearUndo(){actions=[];emit();}
export function offerUndo(label:string,run:()=>Promise<void>){actions=[...actions,{id:++serial,label,run}];emit();}
export function UndoCenter(){const [items,setItems]=useState(actions),[busy,setBusy]=useState<number|null>(null),[error,setError]=useState("");useEffect(()=>{const update=()=>setItems([...actions]);listeners.add(update);return()=>{listeners.delete(update);};},[]);return <aside className="undo-center" aria-label="Thao tác có thể hoàn tác">{items.map(item=><div className="card" key={item.id}><span>{item.label}</span><button className="btn btn-sm" disabled={busy!==null} onClick={()=>{setBusy(item.id);setError("");void item.run().then(()=>{actions=actions.filter(a=>a.id!==item.id);emit();}).catch(e=>setError(String(e))).finally(()=>setBusy(null));}}>Hoàn tác</button><button className="btn btn-sm" aria-label={`Bỏ qua hoàn tác ${item.label}`} onClick={()=>{actions=actions.filter(a=>a.id!==item.id);emit();}}>Đóng</button></div>)}{error&&<p role="alert">{error}</p>}</aside>;}
