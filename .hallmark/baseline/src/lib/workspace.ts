import { useEffect, useState } from "react";
export function readWorkspace<T>(key:string, fallback:T):T {
  try {const raw=localStorage.getItem(`dealsonar.workspace.${key}`);return raw?JSON.parse(raw) as T:fallback;} catch {return fallback;}
}
export function saveWorkspace(key:string,value:unknown) {try {localStorage.setItem(`dealsonar.workspace.${key}`,JSON.stringify(value));}catch { /* Keep in-memory work if browser storage is unavailable. */ }}
export function useWorkspace<T>(key:string,initial:T) {
  const [value,setValue]=useState<T>(()=>readWorkspace(key,initial));
  useEffect(()=>{saveWorkspace(key,value);},[key,value]);
  return [value,setValue] as const;
}
export function clearWorkspace() {for (const key of Object.keys(localStorage)) if(key.startsWith("dealsonar.workspace.")) localStorage.removeItem(key);}

/** One keyboard scope for the topmost modal, restoring the invoking control on close. */
export function useDialogAccessibility() {
  useEffect(()=>{
    let current:HTMLElement|null=null;
    let previous:HTMLElement|null=null;
    const focusable=(el:HTMLElement)=>Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')).filter(e=>!e.closest('[hidden]') && e.getAttribute('aria-hidden')!=="true");
    const update=()=>{
      const dialogs=document.querySelectorAll<HTMLElement>('[role="dialog"]');
      const next=dialogs.item(dialogs.length-1);
      if(next===current)return;
      if(!next){current=null;previous?.focus();previous=null;return;}
      if(!current)previous=document.activeElement as HTMLElement;
      current=next;
      (focusable(next)[0]??next).focus();
    };
    const onKey=(e:KeyboardEvent)=>{
      if(!current)return;
      if(e.key==="Escape") {const close=focusable(current).find(x=>x.tagName==="BUTTON" && /^(Đóng|Huỷ|Hủy)/.test(x.textContent?.trim()??""));if(close){e.preventDefault();close.click();}}
      if(e.key==="Tab"){const all=focusable(current);const first=all[0],last=all[all.length-1];if(e.shiftKey && (document.activeElement===first || !current.contains(document.activeElement))){e.preventDefault();last?.focus();}else if(!e.shiftKey&&(document.activeElement===last||!current.contains(document.activeElement))){e.preventDefault();first?.focus();}}
    };
    const obs=new MutationObserver(update);obs.observe(document.body,{childList:true,subtree:true});document.addEventListener("keydown",onKey);update();
    return()=>{obs.disconnect();document.removeEventListener("keydown",onKey);};
  },[]);
}
