# LWH One Source Inbound Scan (v1.1.0)

Offline-first PWA for receiving One Source inbound trailers when the WMS/network is down.
Capture load info once, scan Pallet ID -> PGID -> QTY for each pallet, then print a scan
sheet with a Code 128 barcode per Pallet ID to key into the WMS later.

## Deploy (GitHub Pages)
1. Create repo `LWH-OneSource-Inbound`, upload everything in this folder to the root.
2. Settings -> Pages -> Deploy from branch `main` / root.
3. URL: https://nbr1hawgfan.github.io/LWH-OneSource-Inbound/

## Before going offline (important)
Open the URL once on every device while it has internet (hotspot or cellular) and wait for
the green **Offline ready** pill. After that it opens with no connection. Add to Home Screen
on phones.

## Using it
- **Start new load**: Load/BOL, Carrier, Item number, Bin class (each accepts a scan).
- **Scan loop**: Pallet ID -> PGID -> QTY. The scanner's Enter (or Tab) suffix advances; QTY saves the pallet.
- Checks: duplicate Pallet ID on this load or any other load on the device, PGID equal to Pallet ID,
  QTY must be a whole number 1-9999 (catches a wrong label scanned into QTY).
- **Camera** buttons scan with the phone camera if there's no hardware scanner.
- **Print scan sheet**: one page per load, Pallet ID barcodes + PGID + QTY + "In WMS" checkbox and sign-off lines.
  Use Save as PDF if no printer is reachable.
- **Close load** locks it; Reopen if needed. Delete requires typing the load number.

## Sync between devices (v1.1)
Every scan saves on the device first, then syncs to Supabase (LWH Companion project) when there's
signal: right after each scan, every 20 seconds, and whenever the app comes back to the screen.
- On each device: Home -> Sync between devices -> enter the sync code and a device name -> Save.
- Header pill: Synced / N to sync / Sync off / Sync code problem.
- Loads, pallets, removals, close/reopen and deletes all sync. The duplicate Pallet ID check covers
  loads from every synced device.
- If signal drops, keep scanning. Changes queue on the device and upload when it reconnects.
- Database details and the SQL to change the code are in `sql/README-sql.md`.

## Data
Stored on the device (IndexedDB, mirrored to localStorage) and, with sync on, in Supabase.
- **Export CSV**: per load or all loads.
- **Back up (file)** / **Restore / merge backup**: fallback for a device that can't sync.
  Merges by load and skips pallets already present.

## Updating
Bump `APP_VERSION` in app.js and `VERSION` in sw.js together, then push.

## Libraries (bundled locally for offline use)
JsBarcode 3.12.3 (Code 128) and html5-qrcode 2.3.8, both under their own licenses.
