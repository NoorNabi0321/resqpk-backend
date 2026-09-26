// A camp's own patient register.
//
// campId comes from the signed token, never from the request. A body or query
// parameter would let any camp admin read another camp's records by changing a
// uuid, and these are medical records.
import campVisitsService from '../services/camp-visits.service.js';
import { successResponse, errorResponse } from '../utils/response.js';

function campIdOf(req) {
  const campId = req.user?.hospital_id;
  if (!campId) throw new Error('This account is not linked to a camp');
  return campId;
}

// POST /api/camp-visits
export async function createVisit(req, res) {
  try {
    const data = await campVisitsService.recordVisit(campIdOf(req), req.user.id, req.body || {});
    return successResponse(res, data, 'Visit recorded', 201);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/camp-visits
export async function listVisits(req, res) {
  try {
    const data = await campVisitsService.listVisits(campIdOf(req), req.query || {});
    return successResponse(res, data, 'Visits', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/camp-visits/summary
export async function getSummary(req, res) {
  try {
    const data = await campVisitsService.getSummary(campIdOf(req));
    return successResponse(res, data, 'Camp summary', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// PUT /api/camp-visits/:id
export async function updateVisit(req, res) {
  try {
    const data = await campVisitsService.updateVisit(
      campIdOf(req),
      req.params.id,
      req.body || {},
    );
    return successResponse(res, data, 'Visit updated', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// DELETE /api/camp-visits/:id
export async function deleteVisit(req, res) {
  try {
    const data = await campVisitsService.deleteVisit(campIdOf(req), req.params.id);
    return successResponse(res, data, 'Visit deleted', 200);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

// GET /api/camp-visits/export.csv
export async function exportCsv(req, res) {
  try {
    const rows = await campVisitsService.exportVisits(campIdOf(req), req.query || {});

    const headers = [
      'Date', 'Name', 'Age', 'Gender', 'Phone', 'Services',
      'Blood pressure', 'Blood sugar', 'Findings', 'Needs follow-up', 'Follow-up note',
    ];
    // A field starting with = + - or @ is executed as a formula when the file
    // is opened in Excel, and these fields are typed by the public.
    const cell = (value) => {
      const s = value == null ? '' : String(value);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };

    const csv = [
      headers.map(cell).join(','),
      ...rows.map((r) => [
        r.visitedOn, r.patientName, r.age ?? '', r.gender ?? '', r.phone ?? '',
        r.servicesGiven.join('; '), r.bloodPressure ?? '', r.bloodSugar ?? '',
        r.findings ?? '', r.needsFollowup ? 'yes' : 'no', r.followupNote ?? '',
      ].map(cell).join(',')),
    ].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="camp-patients.csv"');
    // Byte order mark, or Excel opens Urdu names as mojibake.
    return res.send(`﻿${csv}`);
  } catch (err) {
    return errorResponse(res, err.message, 400);
  }
}

export default { createVisit, listVisits, getSummary, updateVisit, deleteVisit, exportCsv };
