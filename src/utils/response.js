// Standard JSON response helpers. Every API response uses this envelope so
// the Flutter and React clients can parse responses uniformly.

export function successResponse(res, data = null, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    errors: null,
    timestamp: new Date().toISOString(),
  });
}

export function errorResponse(res, message = 'Something went wrong', statusCode = 500, errors = null) {
  return res.status(statusCode).json({
    success: false,
    message,
    data: null,
    errors,
    timestamp: new Date().toISOString(),
  });
}

export default { successResponse, errorResponse };
