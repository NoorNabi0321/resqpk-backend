// Module 8 — first aid guides (public content for offline pre-fetch).
import { supabaseAdmin } from '../config/supabase.js';

const COLUMNS =
  'id, category, title_en, title_ur, slug, emergency_types, steps_en, steps_ur, icon_name, is_featured, display_order, updated_at';

export async function getGuides({ lang = 'en', category, featured } = {}) {
  let query = supabaseAdmin
    .from('first_aid_guides')
    .select(COLUMNS)
    .order('display_order', { ascending: true });

  // Urdu requests only want guides that actually have Urdu steps.
  if (lang === 'ur') query = query.not('steps_ur', 'is', null);
  if (category) query = query.eq('category', category);
  if (featured === true) query = query.eq('is_featured', true);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getGuideBySlug(slug) {
  const { data, error } = await supabaseAdmin
    .from('first_aid_guides')
    .select(COLUMNS)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export default { getGuides, getGuideBySlug };
