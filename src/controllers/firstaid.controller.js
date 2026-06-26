import firstAidService from '../services/firstaid.service.js';
import notificationService from '../services/notification.service.js';
import { successResponse, errorResponse } from '../utils/response.js';

// GET /api/first-aid — public list (cached for offline pre-fetch).
export async function getFirstAidGuides(req, res) {
  try {
    const lang = req.query.lang === 'ur' ? 'ur' : 'en';
    const featured = req.query.featured === 'true' ? true : undefined;
    const guides = await firstAidService.getGuides({
      lang,
      category: req.query.category,
      featured,
    });
    const lastUpdated = guides.reduce(
      (max, g) => (g.updated_at && g.updated_at > max ? g.updated_at : max),
      '',
    );
    res.set('Cache-Control', 'public, max-age=86400'); // 1 day
    return successResponse(
      res,
      { guides, total: guides.length, lastUpdated: lastUpdated || new Date().toISOString() },
      'First aid guides',
      200,
    );
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/first-aid/:slug — single guide (deep link).
export async function getFirstAidGuideBySlug(req, res) {
  try {
    const guide = await firstAidService.getGuideBySlug(req.params.slug);
    if (!guide) return errorResponse(res, 'Guide not found', 404);
    res.set('Cache-Control', 'public, max-age=86400');
    return successResponse(res, guide, 'First aid guide', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// POST /api/first-aid/send-weekly-notification — manual trigger (dev / super_admin).
export async function sendWeeklyNotification(req, res) {
  try {
    const result = await notificationService.sendWeeklyEngagementNotifications();
    return successResponse(res, result, 'Weekly notifications processed', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}
