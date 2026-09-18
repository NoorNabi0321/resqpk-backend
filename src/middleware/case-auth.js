// Authorises a request against ONE case, however the caller proves it.
//
// Two kinds of credential arrive at these endpoints:
//   • a case token — held by an anonymous patient, a WhatsApp user, or whoever
//     opened a tracking link. Scoped to a single case.
//   • a normal user JWT — a signed-in patient, the assigned driver, or hospital
//     staff. The service layer still decides what they may see.
//
// Using one middleware for both keeps every existing authenticated path working
// exactly as before.
import jwt from 'jsonwebtoken';

import config from '../config/env.js';
import { verifyCaseToken } from '../services/case-token.service.js';
import { errorResponse } from '../utils/response.js';

export default function caseAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return errorResponse(res, 'Unauthorized', 401);
  }

  const casePayload = verifyCaseToken(token);
  if (casePayload) {
    // A case token is valid only for its own case. Without this check it would
    // become a master key the moment someone edited the id in the URL.
    const requestedId = req.params.id || req.params.caseId;
    if (requestedId && requestedId !== casePayload.case_id) {
      return errorResponse(res, 'Not authorized to view this case', 403);
    }

    req.caseAccess = { caseId: casePayload.case_id, channel: casePayload.channel };
    // Services authorise against req.user; this shape tells them the caller
    // holds a token for exactly this case.
    req.user = { caseScopedCaseId: casePayload.case_id };
    return next();
  }

  try {
    req.user = jwt.verify(token, config.jwtSecret);
    return next();
  } catch {
    return errorResponse(res, 'Unauthorized', 401);
  }
}
