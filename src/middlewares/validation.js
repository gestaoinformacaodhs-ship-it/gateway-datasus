const { validationResult } = require('express-validator');

/**
 * Generic validation middleware to check for express-validator results.
 */
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) {
        return next();
    }
    
    const extractedErrors = [];
    errors.array().map(err => extractedErrors.push({ [err.path]: err.msg }));

    return res.status(422).json({
        success: false,
        errors: extractedErrors,
    });
};

module.exports = { validate };
