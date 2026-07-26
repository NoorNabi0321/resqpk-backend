-- Fix hospital coordinates: Module 1 seeded placeholder values (Civil Hospital
-- was at 25.3792, 68.3683 — the generic Hyderabad city-center default, which is
-- why its map pin showed near Kacha Qila instead of the real hospital).
-- Real coordinates below are from OpenStreetMap (Nominatim), July 2026.
-- Run in Supabase SQL Editor. Cases join hospitals live, so existing/active
-- cases pick up the corrected pins immediately — no app change needed.

-- Civil Hospital Hyderabad — Hospital Road, Heerabad (near Sarfaraz Colony)
UPDATE hospitals
SET lat = 25.40061, lng = 68.36736
WHERE name = 'Civil Hospital Hyderabad';

-- Liaquat University Hospital — LUMHS campus, N-55, Jamshoro
UPDATE hospitals
SET lat = 25.43283, lng = 68.27092
WHERE name = 'Liaquat University Hospital';

-- Isra University Hospital — Campus Road, Hala Naka side, Qasimabad
UPDATE hospitals
SET lat = 25.43527, lng = 68.38196
WHERE name = 'Isra University Hospital';

-- Verify:
SELECT name, lat, lng FROM hospitals ORDER BY name;
