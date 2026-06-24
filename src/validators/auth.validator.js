// Joi validation schemas for the ResQPK authentication system.
import Joi from 'joi';

// Pakistani phone: +92XXXXXXXXXX (10 digits after +92) or 03XXXXXXXXX (11 digits).
const PK_PHONE_PATTERN = /^(\+92\d{10}|03\d{9})$/;

// Reusable field rules.
const phone = Joi.string().pattern(PK_PHONE_PATTERN).messages({
  'string.pattern.base': 'Phone must be a valid Pakistani number (03XXXXXXXXX or +92XXXXXXXXXX)',
});

const password = Joi.string().min(8).messages({
  'string.min': 'Password must be at least 8 characters',
});

const fullName = Joi.string().min(2).max(100);

const email = Joi.string().email().allow('', null);

// 1. Patient registration
export const patientRegisterSchema = Joi.object({
  full_name: fullName.required(),
  phone: phone.required(),
  email: email.optional(),
  password: password.required(),
});

// 2. Driver registration
export const driverRegisterSchema = Joi.object({
  full_name: fullName.required(),
  phone: phone.required(),
  email: email.optional(),
  password: password.required(),
  vehicle_number: Joi.string().min(2).max(20).required(),
  license_number: Joi.string().min(5).max(50).required(),
  organization: Joi.string()
    .valid('Rescue 1122', 'Edhi Foundation', 'Chhipa Welfare', 'Private', 'Other')
    .default('Private'),
});

// 3. Patient/driver login (phone + password)
export const loginSchema = Joi.object({
  phone: phone.required(),
  password: Joi.string().required(),
});

// 4. Hospital admin login (email + password)
export const hospitalLoginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

// 5. Medical profile — all fields optional (partial update allowed)
export const medicalProfileSchema = Joi.object({
  blood_group: Joi.string().valid('A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'),
  date_of_birth: Joi.date().iso(),
  gender: Joi.string().valid('male', 'female', 'other'),
  weight_kg: Joi.number().min(1).max(300),
  height_cm: Joi.number().min(30).max(250),
  chronic_conditions: Joi.array().items(Joi.string()),
  current_medications: Joi.array().items(Joi.string()),
  allergies: Joi.array().items(Joi.string()),
  emergency_contact_name: Joi.string().max(100).allow('', null),
  emergency_contact_phone: phone.allow('', null),
  emergency_contact_relation: Joi.string().max(50).allow('', null),
  additional_notes: Joi.string().max(1000).allow('', null),
});

// Validates `data` against `schema`.
// Returns { error, value } where error is null on success, or a clean
// array of { field, message } objects on failure.
export function validate(schema, data) {
  const { error, value } = schema.validate(data, {
    abortEarly: false, // collect all errors, not just the first
    stripUnknown: true, // drop keys not defined in the schema
    convert: true, // coerce types (e.g. ISO date strings, numeric strings)
  });

  if (error) {
    const errors = error.details.map((detail) => ({
      field: detail.path.join('.'),
      message: detail.message.replace(/"/g, ''),
    }));
    return { error: errors, value };
  }

  return { error: null, value };
}

export default {
  patientRegisterSchema,
  driverRegisterSchema,
  loginSchema,
  hospitalLoginSchema,
  medicalProfileSchema,
  validate,
};
