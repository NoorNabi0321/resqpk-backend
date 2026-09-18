// Joi validation schemas for the SOS + dispatch system.
import Joi from 'joi';
import { validate } from './auth.validator.js';

// Pakistani mobile numbers: +923001234567, 923001234567 or 03001234567.
const PK_PHONE = /^(\+?92\d{10}|03\d{9})$/;

// 1. SOS trigger
//
// reporterPhone is required only for anonymous callers — the controller
// enforces that, because the schema cannot see whether a JWT was supplied.
// Someone has to be reachable: the driver phones ahead when an address is vague.
export const sosRequestSchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  accuracy: Joi.number().min(0).optional(),
  address: Joi.string().max(300).allow('', null),
  patientNote: Joi.string().max(500).allow('', null),
  reporterPhone: Joi.string().pattern(PK_PHONE).allow('', null).messages({
    'string.pattern.base': 'reporterPhone must be a valid Pakistani number',
  }),
  reporterName: Joi.string().max(100).allow('', null),
  reportedFor: Joi.string().valid('self', 'other').default('self'),
  channel: Joi.string().valid('app', 'whatsapp', 'web').default('app'),
});

// 1b. Reaching a case again with the code printed in the chat or on screen.
export const accessCodeSchema = Joi.object({
  accessCode: Joi.string().min(6).max(20).required(),
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

export { validate };

export default {
  sosRequestSchema,
  accessCodeSchema,
  cancelSOSSchema,
  driverRespondSchema,
  updateCaseStatusSchema,
  validate,
};
