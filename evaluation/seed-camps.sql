-- Demo medical camps for Hyderabad, Sindh.
--
-- Camps are rows in `hospitals` with facility_type = 'medical_camp'; there is
-- no separate table. getNearbyCamps() only returns camps that are approved,
-- active, and running TODAY, which is why the original test rows (26 Jul –
-- 6 Aug 2026) show up as an empty list rather than a failure.
--
-- Dates are relative to current_date, so this stays valid whenever it is run.
-- has_emergency_ward stays false on every row: that flag is what keeps camps
-- out of the ambulance's hospital list, where they do not belong.
--
-- Phone numbers are the organisations' published helplines, not individuals'.
-- Swap them for the actual camp organiser's number before a live demo.

-- Real camps, spread across the city so distance sorting and the map pins are
-- actually exercised rather than stacked on one coordinate.
insert into hospitals (
  name, short_name, facility_type, is_approved, is_active, has_emergency_ward,
  address, city, lat, lng, emergency_phone, phone,
  camp_start_date, camp_end_date, services_offered, organizer_name, description
) values
(
  'Free Eye & Cataract Screening Camp', 'Eye Camp Latifabad', 'medical_camp', true, true, false,
  'Government Girls High School, Unit 8, Latifabad, Hyderabad', 'Hyderabad',
  25.36540000, 68.34190000, '1122', '1122',
  current_date - 2, current_date + 6,
  array['Eye examination', 'Cataract screening', 'Free spectacles', 'Referral for surgery'],
  'Layton Rahmatulla Benevolent Trust (LRBT)',
  'Free eye testing for all ages, with cataract cases referred for surgery at no cost. Bring your CNIC if you have one.'
),
(
  'Mother & Child Health Camp', 'Mother & Child', 'medical_camp', true, true, false,
  'Community Hall, Wadhu Wah Road, Qasimabad, Hyderabad', 'Hyderabad',
  25.40640000, 68.32520000, '115', '115',
  current_date, current_date + 2,
  array['Antenatal check-up', 'Child immunisation', 'Nutrition advice', 'Free medicines'],
  'Edhi Foundation',
  'Antenatal checks, routine child vaccinations and nutrition counselling. Women doctors on site.'
),
(
  'Diabetes & Blood Pressure Screening', 'Diabetes Screening', 'medical_camp', true, true, false,
  'Hirabad Community Centre, near Saddar, Hyderabad', 'Hyderabad',
  25.38730000, 68.36950000, '1122', '1122',
  current_date - 5, current_date + 10,
  array['Blood sugar test', 'Blood pressure check', 'Diet counselling', 'Free medicines'],
  'Indus Hospital Outreach',
  'Walk-in sugar and blood pressure testing with a month of free medicine for anyone newly diagnosed.'
),
(
  'Dengue & Malaria Testing Camp', 'Dengue Testing', 'medical_camp', true, true, false,
  'Basic Health Unit, Tando Yousuf, Hyderabad', 'Hyderabad',
  25.43080000, 68.40420000, '1122', '1122',
  current_date - 1, current_date + 30,
  array['Dengue NS1 test', 'Malaria smear', 'Fever assessment', 'Mosquito net distribution'],
  'Sindh Health Department',
  'Free testing for anyone with fever for more than two days. Results the same day.'
),
(
  'Free Dental Camp', 'Dental Camp', 'medical_camp', true, true, false,
  'Citizen Colony Welfare Office, Hyderabad', 'Hyderabad',
  25.40010000, 68.33500000, '1020', '1020',
  current_date, current_date + 5,
  array['Dental check-up', 'Scaling and cleaning', 'Extraction', 'Oral hygiene advice'],
  'Chhipa Welfare Association',
  'Check-ups, cleaning and extractions by volunteer dentists. Children seen first, before noon.'
);

-- Park the seven "Test Eye Camp <timestamp>" rows left over from registration
-- testing. Deactivated rather than deleted, so the registration flow's own
-- history stays intact.
update hospitals
   set is_active = false
 where facility_type = 'medical_camp'
   and name like 'Test Eye Camp %';

-- --- Undo -------------------------------------------------------------------
-- delete from hospitals
--  where facility_type = 'medical_camp'
--    and organizer_name in (
--      'Layton Rahmatulla Benevolent Trust (LRBT)', 'Edhi Foundation',
--      'Indus Hospital Outreach', 'Sindh Health Department',
--      'Chhipa Welfare Association'
--    );
-- update hospitals set is_active = true
--  where facility_type = 'medical_camp' and name like 'Test Eye Camp %';
