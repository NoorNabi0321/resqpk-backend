import analyticsService from '../services/analytics.service.js';
import { successResponse, errorResponse } from '../utils/response.js';

// GET /api/analytics/overview
export async function getOverview(req, res) {
  try {
    const data = await analyticsService.getOverview(req.user.hospital_id);
    return successResponse(res, data, 'Overview', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/analytics/weekly-response-times
export async function getWeeklyResponseTimes(req, res) {
  try {
    const data = await analyticsService.getWeeklyResponseTimes(req.user.hospital_id);
    return successResponse(res, data, 'Weekly response times', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/analytics/emergency-types
export async function getEmergencyTypes(req, res) {
  try {
    const data = await analyticsService.getEmergencyTypes(req.user.hospital_id);
    return successResponse(res, data, 'Emergency types', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/analytics/hourly-heatmap
export async function getHourlyHeatmap(req, res) {
  try {
    const data = await analyticsService.getHourlyHeatmap(req.user.hospital_id);
    return successResponse(res, data, 'Hourly heatmap', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}
