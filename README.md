# Equipment Repository System

Laravel 13 (API) + React (Vite, Ant Design) + MySQL. It runs fully offline on the local network.

- **Import from Word**: every table in a `.docx` file is read on its own.
  - A table with a header row (like the LUKAS file): each row is one equipment, keyed by the `الرقم التسلسلي` column.
  - A 2-column `Key | Value` table: one equipment.
  - Merged cells, empty rows, and header rows repeated on each page are handled.
  - A review step shows new / already-existing / missing-serial items. For existing items you choose overwrite or skip.
  - You can choose a group for the imported equipment (new and overwritten). **Import from Word** on a group page opens the import with that group chosen.
- **Export**: Excel (.xlsx, right-to-left, one column per field) of the equipment list (same search / filters) and of the history; PDF through print pages (equipment data sheet, equipment list) and the browser's "Save as PDF".
- **Bulk edit**: set / remove a field, or set the category or group, on selected equipment. **Field names** (Settings): merge / rename keys everywhere, including the label design.
- **Maintenance & dates** per equipment (repeating every N months); "Done" logs the work and moves the date forward. Due / overdue list on the home page.
- **Custody (عهدة)**: hand over (optionally with accessories) with a return date, take back; the **العهد** tab lists who holds what, with overdue returns highlighted. Holder names need a PIN.
- **Damage reports**: anyone who scans a label can report a problem with a photo, without a PIN; closing it needs a PIN. Photos are included in backups.
- **Stocktake (جرد)**: start one for all equipment or a filtered location; scan by USB reader / typing (Enter), or by label photo; live found / missing / wrong place / unknown; Excel export.
- **Home page**:
  - Quick actions (scan, import, add, print) and clickable stat tiles.
  - "Equipment by" chart for any field: click a bar to open the filtered list.
  - System health: QR address, labels printed, last backup.
  - "Needs attention": equipment whose data contains words set in Settings.
  - Recent equipment and imports, a QR that opens the system on a phone, and 30-day activity (PIN only).
- **Dashboard**: search any value, filter by category, add/edit/delete equipment with flexible fields.
- **Accessories**: an equipment can have accessories. Each accessory is a full equipment (its own serial, fields, page and QR) linked permanently to one main equipment. You can add them from the equipment page, or create them on import from the columns you choose. Deleting a main equipment also deletes its accessories.
- **Equipment photo**: one photo per equipment, shrunk on the device before upload. Everyone can see it; adding or removing it needs a PIN. Photos are included in backups.
- **Groups (مجموعات)**: a kind of equipment, e.g. «وحدة الفتح والقص», holding every unit of that kind. Each unit keeps its own serial and details.
  - Only main equipment is grouped, and it is in at most one group. Accessories stay under their main equipment.
  - **Auto-group** suggests groups from equipment sharing a name (spelling-insensitive) and applies them only after you confirm.
  - New or imported equipment joins the group with its name.
  - The equipment list has a grouped view (one row per group that opens to its units) and a flat view.
  - Deleting a group keeps its equipment, without a group.
- **Boxes (صناديق)**: a numbered box with a name, a weight and its own QR label (`/box/<number>`) that any phone can open. Viewing is open to everyone; changes need a PIN.
  - An equipment can be in several boxes, and a main equipment brings its accessories in and out with it.
  - Add a new equipment, choose existing ones, or add a whole group at once. Contents are listed by group, with **Take the group out**.
  - The box page shows the number and name, large weight and item-count tiles, and each item's photo, name and up to 3 details. All actions are in one **Actions** menu.
  - Deleting a box keeps its equipment. Adding to and taking out of a box is in the history log.
  - **Box sheet**: the box page as an A4 sheet, with the QR at the left corner beside the box name and the figures stacked. Print it, or download it as PDF or as an editable Word file.
- **QR labels**: each QR holds a link like `http://<PC-IP>/eq/<serial>`. Any phone camera opens it, with no app needed. You can print labels for many items at once, sized for a label printer.
- **QR codes page**:
  - The address printed in QR codes.
  - **Label designer**: a canvas where you drag and resize QR codes, fields (serial, name, ت, main serial, company, or any Word key with a prefix), fixed text and frames.
    - Each text element has its own font size, bold, alignment, shrink-to-fit and wrap; positions are in mm with a 0.5 mm snap; arrow keys nudge.
    - Preview with real equipment.
    - The design is saved and used exactly when printing (`label_template` setting).
  - Printing labels for selected items or for all search/filter results.
  - Settings now only holds the Word serial-column names.
- **Network page**:
  - Shows every address the server can be reached on, as links with a scannable QR, a reachability test, and *Use for QR*, which sets the address printed in labels.
  - Warns when the label address no longer matches the computer, e.g. after the IP changed.
  - Lists the devices that opened the system (device type, user, last seen). Admins can name or block devices.
- **A QR address that never changes after printing**:
  - The Network page has a printable **setup guide for IT**, filled in with this PC's name, IP, MAC and port: DHCP reservation, a DNS name (recommended, e.g. `http://repo`), the firewall command, and a phone test.
  - Every print job counts its labels per QR address. Once labels exist, changing the address shows how many labels would break and needs the new address typed to confirm.
  - **مسح ملصق (Scan label)** reads any label from a photo and opens its equipment, even if the label holds an old address.
- **PIN per person**: viewing is open to everyone. Any change asks for the person's PIN, and the history log records who changed what.
- Arabic (RTL) and English interface.

## Folders

```
backend/    Laravel API + serves the built dashboard (backend/public/app)
frontend/   React source (only needed to change the UI)
windows/    setup scripts for the Windows PC
```

## Install on the Windows laptop (Laragon, phone hotspots)

Follow **`windows/START-HERE.txt`** step by step: install, network, phone test, backups, printing.

The QR codes contain the laptop's name, **`http://repo.local`** (mDNS). It works on any phone hotspot even when the IP changes. Plan B, if a phone can't open `.local`: the laptop is the hotspot, with the fixed address `192.168.137.1`.

| File in `windows/` | What it does |
|---|---|
| `START-HERE.txt` | The setup-day guide |
| `setup.bat` | Installs the system: database, tables (only adds, never re-creates), first admin, first backup |
| `hotspot-setup.ps1` | PowerShell (admin): renames the laptop to `repo`, turns on mDNS, firewall on every network, no sleep, sets the QR address |
| `apache-vhost.conf` | Copy to `C:\laragon\etc\apache2\sites-enabled\00-repo.conf` |
| `backup.bat` / `schedule-backup.bat` | Backup now / daily backup at 14:00 |
| `update.bat` | After copying a new version: backup first, then database changes |
| `find-php.bat` | Finds Laragon's PHP (used by the other scripts) |

### Data safety
- **Backups**: database, original Word files, equipment and damage-report photos, and custody form templates in one zip. Made automatically once a day while the system is used, by the scheduled task, by `update.bat`, and with **Settings → Backups → Back up now**. The oldest are removed beyond the "keep" limit (default 30).
- **Backup folder**: set it in Settings to another disk, a USB stick or a network share.
- **Restore**: `php artisan repo:restore`. The current data is backed up first, so a restore never loses anything.
- With `APP_ENV=production`, Laravel refuses `migrate:fresh`, `migrate:refresh`, `migrate:reset` and `db:wipe`.
- Deleted equipment is soft-deleted, and every change is in the history log.

## Printing labels
Use the **QR codes** page (or select items in **Equipment** → **Print labels**). Each label prints as one page sized like your label (set on the QR codes page). In the browser print dialog choose the label printer, set margins to *None* and scale to 100%. If the printer driver has its own paper size setting, set it to the same label size.

Box labels print from the **Boxes** page or a box's **Actions** menu: only the QR code, as large as the label allows, one label per page. Their label size is chosen on the print page and remembered on that computer.

## Development (on the Mac)

```bash
# backend: MySQL from XAMPP (start MySQL in XAMPP first), database `equipment_repo`
cd backend && php artisan migrate --seed && php artisan serve      # http://127.0.0.1:8000
# start over with an empty database (deletes all data!)
php artisan migrate:fresh --seed

# frontend with hot reload (proxies /api to :8000)
cd frontend && npm install && npm run dev                          # http://localhost:5173

# build the dashboard into backend/public/app (do this before copying to the PC)
cd frontend && npm run build
```

`composer.json` pins the PHP platform to 8.3, so `vendor/` also works on the Windows PC's PHP.

## Word import rules
- After uploading, click **عرض الجداول وتخصيصها (View & customize tables)** for a file. It opens its tables as they look in Word. For each table:
  - Choose the layout: *rows*, *Key | Value*, or *ignore*.
  - Click a row number to make it the header row.
  - Choose a role for every column or key: serial, ت, field (renamable), accessory, or ignore.
  - The result (items and accessories) updates live, and **Apply** updates the review list.
- The serial column is found by name. The names are set in **Settings** → *Serial number column names* (default includes `الرقم التسلسلي` and its `ى` spelling, `Serial Number`, `SN`, `S/N`).
- In a header-row table, the other columns become fields of that equipment. For LUKAS this means the serials of the parts (مضخة يدوية, تمساح…). Empty cells are skipped.
- **Row number «ت»**: the table's row-number column (default names: `ت`, `م`, `تسلسل`, `#`, `No`; edit them in **Settings**) is saved as the equipment's **ت**, not as a normal field. Arabic digits (١٢٣) are understood. ت restarts in every table and stays empty when a table has no ت column. It shows as a sortable column in the equipment list and on the QR label (it can be hidden on the QR page).
- **Accessory columns**: in the review step, choose the columns that hold accessory serials (e.g. `مضخة يدوية`, `تمساح`, `خراطيم`). Each value becomes an accessory named after its column and linked to that row's equipment. A cell with several serials on separate lines creates several accessories. The choice is remembered for the next import. An accessory serial that already belongs to another equipment is reported and skipped.
- A vertically merged cell (e.g. one `المكان` for several rows) gives its value to each row.
- If a table has no serial column, its rows show as *No serial number*. You can type the serials in the review step.
- Only `.docx` is supported. Save old `.doc` files as `.docx` first.
