# DealSonar desktop design

Hallmark full redesign, Furrow theme adapted to a desktop workbench.
Keep all existing Vietnamese business facts, handlers, fields, IPC contracts and routes. User approved editing the dirty working tree; baseline is in .hallmark/baseline/src.
Light warm paper, near-black ink, orange primary action with dark text. Existing CSS variable names map to the theme. System sans for offline Vietnamese readability is allowed in app scope. No remote font dependency.
One consistent navigation rail, restrained dividers, no nested cards, no ornamental status dots, no emoji icons, no uppercase tracked labels or eyebrow text. Use text or inline SVG icons with aria-hidden.
Headings 24/20/16px, body 14px with readable 1.55 leading, controls 36px (44px targets), small metadata 12px minimum. Main content capped at 1440px. Preserve responsive access to all actions.
Screen signatures: Today action ledger; Inbox split queue/detail; lead table full width; Radar management rows; Sources and Contacts operational tables; Health connection stages; Settings section navigation and readable forms. Wizard retains every step and live summary.
Use existing semantic CSS classes. All colors via existing role tokens: --bg-canvas, --bg-surface, --bg-subtle, --border, --border-strong, --text-main, --text-secondary, --text-muted, --primary, --primary-hover, --primary-soft, --success, --success-soft, --warning, --warning-soft, --danger, --danger-soft. Avoid inline literal colors.
