-- Make the guide library match the artwork that exists.
--
-- The library showed Road Accident, Drowning and Cardiac Arrest — none of
-- which have step illustrations — while Fracture, Heatstroke and Eye Injury
-- had a full set of drawings and no guide to attach them to. A first-aid step
-- without a picture is the one people stop reading.
--
-- The three guides being removed do not take their emergencies with them:
-- their emergency_types are folded into the guides that stay, so the AI
-- report's "relevant guide" link still resolves. Cardiac arrest and drowning
-- both end in CPR; a road accident is bleeding and broken bones.

-- 1. The three that have artwork waiting -------------------------------------

insert into first_aid_guides
  (category, title_en, title_ur, slug, emergency_types, steps_en, steps_ur,
   icon_name, is_featured, display_order)
values
(
  'Fracture', 'Broken Bone First Aid', 'ہڈی ٹوٹنے کی ابتدائی امداد', 'fracture-guide',
  array['fracture', 'broken_bone', 'trauma', 'accident', 'road_accident'],
  '[
    {"step":1,"title":"Keep them still","instruction":"Do not move the injured arm or leg, and do not let them walk on it. Moving a broken bone can cut nerves and blood vessels."},
    {"step":2,"title":"Call for help","instruction":"Call 1122 or press SOS. A broken bone needs an X-ray and a doctor."},
    {"step":3,"title":"Stop any bleeding","instruction":"If the wound is bleeding, press around it with a clean cloth. Never press directly on exposed bone."},
    {"step":4,"title":"Support the limb where it lies","instruction":"Pad around it with rolled cloth or towels in the position you found it. Do not try to straighten it."},
    {"step":5,"title":"Cool the swelling","instruction":"Hold a cold pack or ice wrapped in cloth over the area for twenty minutes. Never put ice straight onto skin."},
    {"step":6,"title":"Nothing to eat or drink","instruction":"They may need surgery. Keep them warm, still, and talking until help arrives."}
  ]'::jsonb,
  '[
    {"step":1,"title":"مریض کو ہلائیں نہیں","instruction":"زخمی ہاتھ یا ٹانگ کو حرکت نہ دیں اور نہ ہی مریض کو اس پر چلنے دیں۔ ٹوٹی ہڈی ہلنے سے رگیں کٹ سکتی ہیں۔"},
    {"step":2,"title":"مدد بلائیں","instruction":"1122 پر کال کریں یا SOS دبائیں۔ ٹوٹی ہڈی کے لیے ایکسرے اور ڈاکٹر ضروری ہے۔"},
    {"step":3,"title":"خون روکیں","instruction":"اگر خون بہہ رہا ہو تو صاف کپڑے سے زخم کے اردگرد دبائیں۔ کھلی ہڈی پر براہِ راست نہ دبائیں۔"},
    {"step":4,"title":"جس حالت میں ہے، سہارا دیں","instruction":"کپڑے یا تولیے رکھ کر اسی حالت میں سہارا دیں جس میں ہاتھ یا ٹانگ ملی ہے۔ سیدھا کرنے کی کوشش نہ کریں۔"},
    {"step":5,"title":"ٹھنڈک پہنچائیں","instruction":"کپڑے میں لپٹی برف بیس منٹ کے لیے رکھیں۔ برف براہِ راست جلد پر نہ لگائیں۔"},
    {"step":6,"title":"کھانا پینا نہ دیں","instruction":"آپریشن کی ضرورت ہو سکتی ہے۔ مریض کو گرم، ساکن اور باتوں میں مصروف رکھیں۔"}
  ]'::jsonb,
  'personal_injury', true, 6
),
(
  'Heatstroke', 'Heatstroke First Aid', 'لو لگنے کی ابتدائی امداد', 'heatstroke-guide',
  array['heatstroke', 'heat', 'dehydration', 'fainting'],
  '[
    {"step":1,"title":"Get them out of the heat","instruction":"Move them into shade or a cool room straight away."},
    {"step":2,"title":"Call for help","instruction":"Call 1122 or press SOS. Heatstroke can kill within the hour."},
    {"step":3,"title":"Loosen clothing","instruction":"Take off extra clothing so the body heat can escape."},
    {"step":4,"title":"Cool them fast","instruction":"Pour or sponge cool water over the skin and fan them. Put wet cloth or ice packs at the neck, the armpits and the groin."},
    {"step":5,"title":"Sips of water only if fully awake","instruction":"If they are alert and can hold a cup, let them sip cool water. Give nothing by mouth to someone drowsy or confused."},
    {"step":6,"title":"Keep cooling until help arrives","instruction":"Do not stop. Watch their breathing — if it stops, start CPR."}
  ]'::jsonb,
  '[
    {"step":1,"title":"دھوپ سے نکالیں","instruction":"فوراً سائے یا ٹھنڈی جگہ پر لے جائیں۔"},
    {"step":2,"title":"مدد بلائیں","instruction":"1122 پر کال کریں یا SOS دبائیں۔ لو لگنا ایک گھنٹے میں جان لے سکتا ہے۔"},
    {"step":3,"title":"کپڑے ڈھیلے کریں","instruction":"اضافی کپڑے اتار دیں تاکہ جسم کی گرمی نکل سکے۔"},
    {"step":4,"title":"جلدی ٹھنڈا کریں","instruction":"جسم پر ٹھنڈا پانی ڈالیں اور پنکھا کریں۔ گردن، بغلوں اور رانوں کے درمیان گیلا کپڑا یا برف رکھیں۔"},
    {"step":5,"title":"ہوش میں ہوں تو پانی کے گھونٹ","instruction":"اگر مریض پوری طرح ہوش میں ہے تو ٹھنڈا پانی گھونٹ گھونٹ پلائیں۔ غنودگی کی حالت میں منہ سے کچھ نہ دیں۔"},
    {"step":6,"title":"مدد آنے تک ٹھنڈا کرتے رہیں","instruction":"رکیں نہیں۔ سانس پر نظر رکھیں؛ سانس بند ہو جائے تو CPR شروع کریں۔"}
  ]'::jsonb,
  'thermostat', false, 7
),
(
  'Eye Injury', 'Eye Injury First Aid', 'آنکھ کی چوٹ کی ابتدائی امداد', 'eye-injury-guide',
  array['eye_injury', 'eye', 'chemical', 'foreign_body'],
  '[
    {"step":1,"title":"Do not rub the eye","instruction":"Rubbing pushes dust or glass deeper and can scar the eye permanently."},
    {"step":2,"title":"Chemicals? Rinse now","instruction":"Hold the eye open and pour clean water across it from the inner corner for fifteen to twenty minutes. Do not stop to look for an eye wash."},
    {"step":3,"title":"Something stuck in it? Leave it","instruction":"Never pull an object out of an eye. Cover it with a paper cup or clean cloth and tape that in place."},
    {"step":4,"title":"Cover both eyes","instruction":"Eyes move together. Covering both keeps the injured one still."},
    {"step":5,"title":"Get to a doctor","instruction":"Call 1122 or go to hospital. Eye injuries are judged by an eye specialist, not at home."}
  ]'::jsonb,
  '[
    {"step":1,"title":"آنکھ نہ ملیں","instruction":"ملنے سے مٹی یا شیشہ اندر چلا جاتا ہے اور آنکھ پر مستقل نشان پڑ سکتا ہے۔"},
    {"step":2,"title":"کیمیکل ہو تو فوراً دھوئیں","instruction":"آنکھ کھول کر اندرونی کونے سے صاف پانی پندرہ سے بیس منٹ تک بہائیں۔"},
    {"step":3,"title":"کوئی چیز چبھی ہو تو نکالیں نہیں","instruction":"آنکھ میں پھنسی چیز کبھی نہ کھینچیں۔ کاغذی گلاس یا صاف کپڑے سے ڈھانپ کر ٹیپ لگا دیں۔"},
    {"step":4,"title":"دونوں آنکھیں ڈھانپیں","instruction":"آنکھیں ساتھ حرکت کرتی ہیں۔ دونوں ڈھانپنے سے زخمی آنکھ ساکن رہتی ہے۔"},
    {"step":5,"title":"ڈاکٹر کے پاس جائیں","instruction":"1122 پر کال کریں یا ہسپتال جائیں۔ آنکھ کی چوٹ کا فیصلہ ماہرِ امراضِ چشم ہی کرتا ہے۔"}
  ]'::jsonb,
  'visibility', false, 8
)
on conflict (slug) do nothing;

-- 2. Keep the emergencies, drop the unillustrated guides ----------------------

update first_aid_guides
   set emergency_types = array['cardiac', 'unconscious', 'cardiac_arrest',
                               'heart_attack', 'drowning', 'water', 'swimming']
 where slug = 'cpr-guide';

update first_aid_guides
   set emergency_types = array['bleeding', 'wound', 'laceration', 'cut',
                               'trauma', 'accident', 'road_accident']
 where slug = 'bleeding-control-guide';

delete from first_aid_guides
 where slug in ('road-accident-guide', 'drowning-guide', 'cardiac-arrest-guide');

-- 3. Order the eight that remain, most common first ---------------------------

update first_aid_guides set display_order = 1, is_featured = true  where slug = 'cpr-guide';
update first_aid_guides set display_order = 2, is_featured = true  where slug = 'choking-guide';
update first_aid_guides set display_order = 3, is_featured = true  where slug = 'bleeding-control-guide';
update first_aid_guides set display_order = 4, is_featured = true  where slug = 'burns-guide';
update first_aid_guides set display_order = 5, is_featured = true  where slug = 'snake-bite-guide';
update first_aid_guides set display_order = 6, is_featured = true  where slug = 'fracture-guide';
update first_aid_guides set display_order = 7, is_featured = false where slug = 'heatstroke-guide';
update first_aid_guides set display_order = 8, is_featured = false where slug = 'eye-injury-guide';
