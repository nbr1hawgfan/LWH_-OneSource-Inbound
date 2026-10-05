# LWH One Source Inbound Scan (v1.0.0)

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

## Data
Stored only on that device (IndexedDB, mirrored to localStorage). Clearing browser data deletes it.
- **Export CSV**: per load or all loads.
- **Back up (file)** / **Restore / merge backup**: move loads between devices (e.g. phone -> laptop).
  Merges by load and skips pallets already present.

## Updating
Bump `APP_VERSION` in app.js and `VERSION` in sw.js together, then push.

## Libraries (bundled locally for offline use)
JsBarcode 3.12.3 (Code 128) and html5-qrcode 2.3.8, both under their own licenses.
