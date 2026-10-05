# Supabase objects (LWH Companion project, already applied 2026-10-05)

Migration name: `os_inbound_scan_sync`

- `os_inbound_loads`, `os_inbound_pallets`: RLS on, no policies, no anon/authenticated table grants.
- `os_inbound_access`: holds the sha256 hash of the dock sync code (single row, id = 1).
- `os_inbound_check(code)`: internal only; 25 wrong codes locks sync for 10 minutes.
- `os_inbound_sync(p_code, p_loads, p_since, p_device)`: the only function the app calls.
  Pushes pending changes (merge-safe: pallets upsert by load + pallet key, removals are soft deletes,
  load headers use last-edit-wins), then returns loads changed since p_since.

## Change the sync code
```sql
update os_inbound_access
   set code_hash = encode(sha256(convert_to('NEWCODE','UTF8')),'hex'),
       failed_attempts = 0, locked_until = null
 where id = 1;
```
Devices with the old code show "Sync code problem" until the new code is entered.

## Handy queries
```sql
-- Everything received during the outage
select l.load_no, l.carrier, l.item_no, l.bin_class, l.status,
       p.pallet_id, p.pgid, p.qty, p.scanned_at, p.device
from os_inbound_loads l
join os_inbound_pallets p on p.load_id = l.id and not p.deleted
where not l.deleted
order by l.created_at, p.scanned_at;

-- Same pallet ID on more than one load (should be empty)
select pallet_key, count(distinct load_id) from os_inbound_pallets
where not deleted group by pallet_key having count(distinct load_id) > 1;
```
