import React from "react";

const paths: Record<string, React.ReactNode> = {
  radar: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><path d="M12 12 19 5" /><circle cx="12" cy="12" r="1" /></>,
  radars: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><path d="m12 12 7-7" /></>,
  today: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4m8-4v4M4 10h16m-11 5 2 2 4-4" /></>,
  inbox: <><path d="m4 4-2 12v4h20v-4L20 4ZM2 15h6l2 3h4l2-3h6" /></>,
  sources: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 17h7m-3.5-3.5v7" /></>,
  contacts: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-16a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 4v2" /></>,
  health: <><path d="M8 3v4m8-4v4M6 7h12v3a6 6 0 0 1-12 0Zm6 9v5" /></>,
  settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5m0 3v1" /></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  device: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
};

export function AppIcon({ name, className = "" }: { name: string; className?: string }) {
  return <svg className={`app-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.radar}</svg>;
}
