import React, { useCallback, useEffect, useState } from "react";
import {LeadDetailPanel} from "../components/LeadDetailPanel";
import {offerUndo} from "../components/UndoCenter";
import { api } from "../lib/api";
import { formatDomesticPhone, formatRelativeTime } from "../lib/format";
import type {
  BlocklistEntry,
  BlocklistKind,
  Contact,
  ContactDetail,
  Radar,
} from "../types/ipc";

interface ContactsScreenProps {
  radars: Radar[];
}

export const ContactsScreen: React.FC<ContactsScreenProps> = ({ radars }) => {
  const [leadId,setLeadId]=useState<string|null>(null);
  const [tab, setTab] = useState<"contacts" | "blocklist">("contacts");

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactSearch, setContactSearch] = useState("");
  const [selectedContact, setSelectedContact] = useState<ContactDetail | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const [blocklist, setBlocklist] = useState<BlocklistEntry[]>([]);
  const [newBlockKind, setNewBlockKind] = useState<BlocklistKind>("author");
  const [newBlockVal, setNewBlockVal] = useState("");
  const [newBlockReason, setNewBlockReason] = useState("");
  const [newBlockRadarId, setNewBlockRadarId] = useState<string>("");

  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const loadContacts = useCallback(async () => {
    const list = await api.contactList(contactSearch.trim() || null);
    setContacts(list);
  }, [contactSearch]);

  const loadBlocklist = useCallback(async () => {
    const list = await api.blocklistList();
    setBlocklist(list);
  }, []);

  useEffect(() => {
    void loadContacts();
    void loadBlocklist();
  }, [loadContacts, loadBlocklist]);

  const openContact = async (id: string) => {
    const d = await api.contactGet(id);
    setSelectedContact(d);
    setNoteDraft(d.contact.note ?? "");
  };

  const handleSaveContactNote = async () => {
    if (!selectedContact) return;
    await api.contactNote(selectedContact.contact.id, noteDraft);
    await openContact(selectedContact.contact.id);
    await loadContacts();
    setStatusMsg("Đã lưu ghi chú liên hệ.");
  };

  const handleBlockContact = async (c: Contact) => {
    const before=new Set((await api.blocklistList()).map(b=>b.id));
    const result=await api.contactBlock(c.id, "Chặn từ màn Danh bạ");
    const added=result.blocked_entries.filter(b=>!before.has(b.id));
    if(added.length)offerUndo(`Đã chặn ${c.display_name}`,async()=>{for(const b of added)await api.blocklistRemove(b.id);await loadContacts();await loadBlocklist();});
    await loadContacts();
    await loadBlocklist();
    if (selectedContact?.contact.id === c.id) {
      await openContact(c.id);
    }
    setStatusMsg(`Đã chặn liên hệ «${c.display_name}».`);
  };

  const handleAddBlocklist = async () => {
    if (!newBlockVal.trim()) return;
    const existing=new Set((await api.blocklistList()).map(b=>b.id));
    const added=await api.blocklistAdd(
      newBlockKind,
      newBlockVal.trim(),
      newBlockReason.trim() || null,
      newBlockRadarId || null
    );
    if(!existing.has(added.id))offerUndo("Đã thêm mục chặn",async()=>{await api.blocklistRemove(added.id);await loadBlocklist();await loadContacts();});
    setNewBlockVal("");
    setNewBlockReason("");
    await loadBlocklist();
    setStatusMsg("Đã thêm mục mới vào Danh sách chặn.");
  };

  return (
    <div>
      <div className="screen-header">
        <div>
          <h1 className="screen-title">Danh bạ & Danh sách chặn</h1>
          <p className="screen-subtitle">
            Gộp người đăng theo số điện thoại chuẩn hoá E.164 · Quản lý chặn tác giả, SĐT và từ khoá
          </p>
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className={`btn ${tab === "contacts" ? "btn-primary" : ""}`}
            onClick={() => setTab("contacts")}
          >
            Danh bạ liên hệ ({contacts.length})
          </button>
          <button
            type="button"
            className={`btn ${tab === "blocklist" ? "btn-primary" : ""}`}
            onClick={() => setTab("blocklist")}
          >
            Danh sách chặn ({blocklist.length})
          </button>
        </div>
      </div>

      {leadId&&<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Cơ hội của liên hệ"><div className="modal-panel"><div className="modal-body"><LeadDetailPanel key={leadId} leadId={leadId} onClose={()=>setLeadId(null)} onUpdated={()=>void loadContacts()}/></div></div></div>}
      {statusMsg && (
        <div className="health-banner info" style={{ borderRadius: 6, marginBottom: 12 }}>
          <span>{statusMsg}</span>
        </div>
      )}

      {tab === "contacts" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 14 }}>
          <div>
            <div className="toolbar-row">
              <input
                type="search"
                className="input"
                placeholder="Tìm theo tên, số điện thoại, ghi chú…"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
              />
            </div>

            <div className="table-wrap">
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Tên hiển thị</th>
                    <th>Số điện thoại (E.164 → Quốc nội)</th>
                    <th>Số tin</th>
                    <th>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr
                      key={c.id}
                      style={{ cursor: "pointer" }}
                      onClick={() => void openContact(c.id)}
                    >
                      <td>
                        <strong>{c.display_name}</strong>
                        {c.is_blocked && (
                          <span className="badge badge-danger" style={{ marginLeft: 6 }}>
                            Đã chặn
                          </span>
                        )}
                      </td>
                      <td>
                        {c.phones.length > 0
                          ? c.phones.map(formatDomesticPhone).join(", ")
                          : "Chưa có SĐT"}
                      </td>
                      <td>{c.lead_count} tin</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={c.is_blocked}
                          onClick={() => void handleBlockContact(c)}
                        >
                          {c.is_blocked ? "Đã chặn" : "Chặn"}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {contacts.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ textAlign: "center", padding: 22 }}>
                        Chưa có liên hệ nào.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            {selectedContact ? (
              <div>
                <h3 style={{ marginTop: 0 }}>{selectedContact.contact.display_name}</h3>
                <div className="field-hint" style={{ marginBottom: 10 }}>
                  SĐT:{" "}
                  {selectedContact.contact.phones.map((p) => `${formatDomesticPhone(p)} (${p})`).join(", ") ||
                    "Chưa có"}
                </div>

                <div className="field-group">
                  <label className="field-label">Ghi chú liên hệ</label>
                  <textarea
                    className="textarea"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                  />
                  <div>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => void handleSaveContactNote()}
                    >
                      Lưu ghi chú
                    </button>
                  </div>
                </div>

                <strong>Lịch sử tin khớp ({selectedContact.leads.length}):</strong>
                <ul style={{ paddingLeft: 18, marginTop: 6 }}>
                  {selectedContact.leads.map((l) => (
                    <li key={l.id} style={{ marginBottom: 6 }}>
                      <button className="btn btn-sm" onClick={()=>setLeadId(l.id)}><strong>[{l.radar_name}]</strong> {l.summary}</button> (
                      {formatRelativeTime(l.created_at)})
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="text-muted">Chọn một liên hệ bên trái để xem lịch sử tin và ghi chú.</div>
            )}
          </div>
        </div>
      ) : (
        <div>
          <div className="card" style={{ marginBottom: 14 }}>
            <strong style={{ display: "block", marginBottom: 8 }}>
              Thêm mục chặn mới (Loại ngay ở tầng lọc sơ bộ T3, không gọi AI)
            </strong>
            <div style={{ display: "grid", gridTemplateColumns: "160px 1fr 1fr 190px auto", gap: 8 }}>
              <select
                aria-label="Loại mục chặn"
                className="select"
                value={newBlockKind}
                onChange={(e) => setNewBlockKind(e.target.value as BlocklistKind)}
              >
                <option value="author">Tác giả (author)</option>
                <option value="phone">Số điện thoại (E.164)</option>
                <option value="keyword">Từ khoá chặn</option>
              </select>
              <input
                type="text"
                className="input"
                placeholder="ID/tên tác giả, +84912..., hoặc cụm từ khoá"
                value={newBlockVal}
                onChange={(e) => setNewBlockVal(e.target.value)}
              />
              <input
                type="text"
                className="input"
                placeholder="Lý do chặn (tuỳ chọn)"
                value={newBlockReason}
                onChange={(e) => setNewBlockReason(e.target.value)}
              />
              <select
                aria-label="Phạm vi radar chặn"
                className="select"
                value={newBlockRadarId}
                onChange={(e) => setNewBlockRadarId(e.target.value)}
              >
                <option value="">Áp dụng mọi Radar</option>
                {radars.map((r) => (
                  <option key={r.id} value={r.id}>
                    Chỉ {r.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleAddBlocklist()}
              >
                + Thêm chặn
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Loại</th>
                  <th>Giá trị chặn</th>
                  <th>Phạm vi</th>
                  <th>Lý do</th>
                  <th>Thời gian thêm</th>
                  <th>Bỏ chặn</th>
                </tr>
              </thead>
              <tbody>
                {blocklist.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <span className="badge">
                        {b.kind === "author"
                          ? "Tác giả"
                          : b.kind === "phone"
                            ? "Số điện thoại"
                            : "Từ khoá"}
                      </span>
                    </td>
                    <td>
                      <strong>{b.display_label ?? b.value}</strong>
                    </td>
                    <td>
                      {b.radar_id
                        ? radars.find((r) => r.id === b.radar_id)?.name ?? b.radar_id
                        : "Mọi Radar"}
                    </td>
                    <td>{b.reason ?? "—"}</td>
                    <td>{formatRelativeTime(b.created_at)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          await api.blocklistRemove(b.id);
                          offerUndo("Đã bỏ chặn",async()=>{await api.blocklistAdd(b.kind,b.value,b.reason,b.radar_id);await loadBlocklist();await loadContacts();});
                          await loadContacts();
                          await loadBlocklist();
                        }}
                      >
                        Bỏ chặn
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
