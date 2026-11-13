# Equipment Repository System

[العربية](README.md) · Screenshots: [docs/screenshots](docs/screenshots)

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
- **Accessories**: an equipment can have accessories. Each accessory is a full equipment (its own fields and page) linked permanently to one main equipment. Its serial has no rules: it may repeat or be empty. A QR label needs a serial, and when a serial is shared, scanning or searching it opens the main equipment first. Only main equipment must have a unique serial. You can add them from the equipment page, or create them on import from the columns you choose. Deleting a main equipment also deletes its accessories.
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
- **Work offline (phones)**: on the **Work offline** page a phone downloads all equipment, accessories, boxes, maintenance dates and problem reports, with photos if you tick it. Later, with no connection to the system, scanning a label with the phone camera still opens the equipment or box page, with a yellow **Offline** bar and the date of the data.
  - View only: changes and problem reports need the connection. History and custody holders are never stored on the phone.
  - Phones allow this only on **https**: run `windows/https-setup.ps1` once and install its certificate once on each phone (the page shows how). The QR address becomes `https://repo.local`, and only labels printed with it open without a connection.
  - Download again before each trip. On iPhone, Safari may clear the data if the system is not opened for about a week.
- **PIN per person**: viewing is open to everyone. Any change asks for the person's PIN, and the history log records who changed what.
- Arabic (RTL) and English interface.

## Folders

```
backend/    Laravel API + serves the built dashboard (backend/public/app)
frontend/   React source (only needed to change the UI)
windows/    setup scripts for the Windows PC
```

## Install on the Windows laptop (XAMPP, phone hotspots)

Follow **`windows/START-HERE.txt`** (in Arabic) step by step: install, network, phone test, https, backups, printing.

- **XAMPP**: MySQL comes from XAMPP; the system lives in `C:\repo` and runs on PHP 8.3+ from `C:\php` through `start-server.bat`. After `https-setup.ps1`, XAMPP's Apache sits in front of it for http and https.
- **Laragon**: an alternative, in the appendix at the end of the guide.

The QR codes contain the laptop's name, **`https://repo.local`** (mDNS). It works on any phone hotspot even when the IP changes. Plan B, if a phone can't open `.local`: the laptop is the hotspot, with the fixed address `192.168.137.1`.

| File in `windows/` | What it does |
|---|---|
| `START-HERE.txt` | The setup-day guide |
| `setup.bat` | Installs the system: database, tables (only adds, never re-creates), first admin, first backup |
| `start-server.bat` | Runs the system on PHP (keep its window open): on port 80, or on `127.0.0.1:8000` behind Apache once `https-setup.ps1` set up XAMPP |
| `hotspot-setup.ps1` | PowerShell (admin): renames the laptop to `repo`, turns on mDNS, firewall on every network, no sleep, sets the QR address |
| `https-setup.ps1` | PowerShell (admin): the system's certificate for https, port 443, QR address `https://repo.local`. Needed for phones to open labels without a connection. With **XAMPP** it puts XAMPP's Apache in front of the system (http 80 + https 443) and `start-server.bat` then runs it on `127.0.0.1:8000`; with **Laragon** it checks Laragon's Apache |
| `apache-proxy.conf` | The Apache settings `https-setup.ps1` puts in XAMPP (not copied by hand) |
| `apache-vhost.conf` | Laragon only: copy to `C:\laragon\etc\apache2\sites-enabled\00-repo.conf` (its https part starts after `https-setup.ps1`) |
| `backup.bat` / `schedule-backup.bat` | Backup now / daily backup at 14:00 |
| `update.bat` | After copying a new version: backup first, then database changes |
| `find-php.bat` | Finds PHP 8.3+ in PATH or `C:\php` (used by the other scripts) |

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
- After uploading, click **فتح الملف وتخصيصه (Open & customize file)**. It opens the file's tables on one full page, as they look in Word, with a toolbar above them. Changes apply to this import only; the Word file does not change.
  - **Edit**: type in any cell, insert or delete rows and columns, paste a block from Excel, and undo with Ctrl+Z. **New table** adds a table of your own.
  - **Select with the mouse**: drag, or use Shift and Ctrl; a row number or column head selects the whole line. Then choose a type for the selection: serial, ت, field, accessory or ignore. Selecting a header cell or every item in a column sets the column; fewer cells set those cells only.
  - **Link to a cell**: select a cell, press **Link to a cell**, then click the cell to take the value from. The value follows later edits to that cell. On a cell in an item's row, it sets that item's field. On a header or title cell, the cell's text is the field name and every item in the table gets it.
  - **Group**: each table can use the group from the review page, no group, an existing group or a new one. Rows can have their own choice from the toolbar. "No group" also stops the item joining a group with its name; an item being overwritten keeps its current group.
  - For each table choose the layout: *rows*, *Key | Value* or *ignore*. The star button makes the selected row the header row.
  - Opening the file and applying again clears the changes made in the review list for that file.
- The serial column is found by name. The names are set in **Settings** → *Serial number column names* (default includes `الرقم التسلسلي` and its `ى` spelling, `Serial Number`, `SN`, `S/N`).
- In a header-row table, the other columns become fields of that equipment. For LUKAS this means the serials of the parts (مضخة يدوية, تمساح…). Empty cells are skipped.
- **Row number «ت»**: the table's row-number column (default names: `ت`, `م`, `تسلسل`, `#`, `No`; edit them in **Settings**) is saved as the equipment's **ت**, not as a normal field. Arabic digits (١٢٣) are understood. ت restarts in every table and stays empty when a table has no ت column. It shows as a sortable column in the equipment list and on the QR label (it can be hidden on the QR page).
- **Accessory columns**: in the review step, choose the columns that hold accessories (e.g. `مضخة يدوية`, `تمساح`, `خراطيم`). Each value becomes an accessory named after its column and linked to that row's equipment. A cell with several lines creates several accessories.
  - A number of up to 3 digits is how many there are. It is saved in the accessory's `عدد` field, and its serial is made from the equipment's: serial `5501` gives `5501ACC01`, `5501ACC02`… in the order of the accessories in that row. Arabic text after the number (`1حقيبة كتان`) goes in a `ملاحظات` field.
  - Any other value is the accessory's own serial. A count of 0, or a cell with no letter or digit such as `-`, creates no accessory.
  - Importing the same row again updates these accessories, including ones saved earlier with the count as their serial. The choice is remembered for the next import. The same serial may repeat on other equipment; importing the same accessory again under the same equipment adds nothing.
- A vertically merged cell (e.g. one `المكان` for several rows) gives its value to each row.
- If a table has no serial column, its rows show as *No serial number*. You can type the serials in the review step.
- Only `.docx` is supported. Save old `.doc` files as `.docx` first.
