-- Urdu steps for the four guides that never had them.
--
-- CPR, choking, burns and snake bite shipped with steps_ur null. The model
-- falls back to English when steps_ur is empty, so the language toggle on
-- those four silently did nothing — the reader pressed اردو and got the same
-- English steps back, with no way to tell it had failed rather than that the
-- app simply worked that way.
--
-- Wording follows the four guides that already had Urdu: plain spoken register
-- rather than textbook Urdu, one instruction per sentence, "1122 پر کال کریں
-- یا SOS دبائیں" for the call step. The English is translated as written and
-- not expanded, so the two languages stay the same guide.
--
-- Guarded by steps_ur is null: re-running this cannot overwrite a translation
-- that was reviewed and corrected after the fact.

update first_aid_guides set steps_ur = '[
  {"step":1,"title":"ہوش چیک کریں","instruction":"مریض کے کندھے پر تھپکی دیں اور زور سے پکاریں۔ دیکھیں کہ وہ جواب دیتا ہے یا نہیں۔"},
  {"step":2,"title":"مدد بلائیں","instruction":"کسی کو 1122 پر کال کرنے یا SOS دبانے کو کہیں، اور خود سی پی آر شروع کر دیں۔"},
  {"step":3,"title":"ہاتھ رکھیں","instruction":"اپنی ہتھیلی کا نچلا حصہ مریض کے سینے کے بالکل بیچ میں رکھیں۔"},
  {"step":4,"title":"سینے کو دبائیں","instruction":"سینے کو زور سے اور تیزی سے دبائیں — ایک منٹ میں 100 سے 120 بار، 5 سے 6 سینٹی میٹر گہرا۔"},
  {"step":5,"title":"مصنوعی سانس","instruction":"ہر 30 دباؤ کے بعد 2 مصنوعی سانس دیں، بشرطیکہ آپ نے اس کی تربیت لی ہو۔"},
  {"step":6,"title":"جاری رکھیں","instruction":"مدد آنے تک یا مریض میں زندگی کے آثار ظاہر ہونے تک رکیں نہیں۔"}
]'::jsonb
where slug = 'cpr-guide' and steps_ur is null;

update first_aid_guides set steps_ur = '[
  {"step":1,"title":"علامات پہچانیں","instruction":"بول نہ سکنا، کمزور کھانسی، رنگ نیلا پڑ جانا، گلے پر ہاتھ رکھنا — یہ دم گھٹنے کی علامات ہیں۔"},
  {"step":2,"title":"کھانسنے دیں","instruction":"اگر مریض زور سے کھانس سکتا ہے تو اسے کھانستے رہنے کی ہمت دلائیں۔"},
  {"step":3,"title":"کمر پر ضربیں","instruction":"ہتھیلی کے نچلے حصے سے کندھوں کے درمیان 5 بار مضبوطی سے ماریں۔"},
  {"step":4,"title":"پیٹ پر دباؤ","instruction":"مریض کے پیچھے کھڑے ہو کر ناف کے اوپر مٹھی رکھیں اور 5 بار اندر کی طرف اوپر کو جھٹکا دیں۔"},
  {"step":5,"title":"باری باری دہرائیں","instruction":"5 ضربیں کمر پر اور 5 جھٹکے پیٹ پر — چیز نکلنے تک باری باری دہراتے رہیں۔"}
]'::jsonb
where slug = 'choking-guide' and steps_ur is null;

update first_aid_guides set steps_ur = '[
  {"step":1,"title":"جلنا روکیں","instruction":"مریض کو آگ یا گرمی سے دور کریں۔ جلی جگہ کے قریب کپڑے اور زیور اتار دیں، مگر جو چپک گیا ہو اسے نہ کھینچیں۔"},
  {"step":2,"title":"ٹھنڈا کریں","instruction":"جلی جگہ کو کم از کم بیس منٹ تک بہتے ہوئے ٹھنڈے پانی کے نیچے رکھیں۔ پانی برف جیسا ٹھنڈا نہ ہو۔"},
  {"step":3,"title":"یہ ہرگز نہ کریں","instruction":"جلی جگہ پر برف، مکھن، ٹوتھ پیسٹ یا کوئی کریم نہ لگائیں۔"},
  {"step":4,"title":"ڈھانپ دیں","instruction":"صاف اور بے روئیں کپڑے سے ڈھیلا ڈھانپ دیں۔ کچن والی پلاسٹک شیٹ بہترین رہتی ہے۔"},
  {"step":5,"title":"ہسپتال لے جائیں","instruction":"اگر جلن ہاتھ سے بڑی ہو، یا چہرے، ہاتھوں یا شرم گاہ پر ہو، یا کیمیکل سے ہو تو فوراً ہسپتال جائیں۔"}
]'::jsonb
where slug = 'burns-guide' and steps_ur is null;

update first_aid_guides set steps_ur = '[
  {"step":1,"title":"مریض کو پُرسکون رکھیں","instruction":"مریض کو پُرسکون اور ساکن رکھیں۔ حرکت سے زہر جسم میں تیزی سے پھیلتا ہے۔"},
  {"step":2,"title":"یہ ہرگز نہ کریں","instruction":"کاٹے ہوئے مقام کو چیریں نہیں، منہ سے زہر نہ چوسیں اور رسی یا کپڑا کَس کر نہ باندھیں۔ ان سے نقصان بڑھتا ہے۔"},
  {"step":3,"title":"ساکن رکھیں","instruction":"کاٹا ہوا ہاتھ یا ٹانگ دل سے نیچے رکھیں اور ٹوٹی ہڈی کی طرح سہارا دے کر ساکن کر دیں۔"},
  {"step":4,"title":"تنگ چیزیں اتار دیں","instruction":"انگوٹھیاں، گھڑی اور تنگ کپڑے فوراً اتار دیں — سوجن آنے والی ہے۔"},
  {"step":5,"title":"ہسپتال پہنچیں","instruction":"علاج صرف اینٹی وینم ہے۔ فوراً ایسے ہسپتال پہنچیں جہاں ایمرجنسی کی سہولت ہو۔"}
]'::jsonb
where slug = 'snake-bite-guide' and steps_ur is null;

-- Every guide must now answer in both languages, and each translation must
-- have exactly as many steps as the English it mirrors.
do $$
declare
  broken text;
begin
  select string_agg(slug, ', ') into broken
  from first_aid_guides
  where steps_ur is null
     or jsonb_array_length(steps_ur) <> jsonb_array_length(steps_en);

  if broken is not null then
    raise exception 'guides with missing or mismatched Urdu: %', broken;
  end if;
end $$;
