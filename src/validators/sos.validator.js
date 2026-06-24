// Joi validation schemas for the SOS + dispatch system.
import Joi from 'joi';
import { validate } from './auth.validator.js';

// Accepts the formats normalizePhone() handles: +92XXXXXXXXXX, 92XXXXXXXXXX, 03XXXXXXXXX.
const GATEWAY_PHONE_PATTERN = /^(\+?92\d{10}|03\d{9})$/;

// 1. SOS trigger
export const sosRequestSchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  accuracy: Joi.number().min(0).optional(),
  triggerMethod: Joi.string().valid('app_sos', 'missed_call', 'sms').default('app_sos'),
  address: Joi.string().max(300).allow('', null),
  patientNote: Joi.string().max(500).allow('', null),
});

// 2. Cancel SOS
export const cancelSOSSchema = Joi.object({
  caseId: Joi.string().uuid().required(),
  reason: Joi.string().valid('false_alarm', 'resolved', 'changed_mind').default('false_alarm'),
});

// 3. Driver responds to a dispatch request
export const driverRespondSchema = Joi.object({
  caseId: Joi.string().uuid().required(),
  response: Joi.string().valid('accepted', 'declined').required(),
});

// 4. Driver updates case status
export const updateCaseStatusSchema = Joi.object({
  caseId: Joi.string().uuid().required(),
  status: Joi.string().valid('en_route', 'arrived', 'completed').required(),
});

// 5. Missed-call webhook (from the Android gateway)
export const missedCallSOSSchema = Joi.object({
  callerPhone: Joi.string().pattern(GATEWAY_PHONE_PATTERN).required().messages({
    'string.pattern.base': 'callerPhone must be a valid Pakistani number',
  }),
  gatewaySecret: Joi.string().required(),
});

export { validate };

export default {
  sosRequestSchema,
  cancelSOSSchema,
  driverRespondSchema,
  updateCaseStatusSchema,
  missedCallSOSSchema,
  validate,
};
