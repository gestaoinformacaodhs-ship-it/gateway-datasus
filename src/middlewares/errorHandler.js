const logger = require('../config/logger');

/**
 * Standard error handling middleware.
 */
const errorHandler = (err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    // Log the error
    logger.error(`${statusCode} - ${message} - ${req.originalUrl} - ${req.method} - ${req.ip}`, {
        stack: err.stack,
    });

    res.status(statusCode).json({
        success: false,
        error: process.env.NODE_ENV === 'production' ? message : err.stack,
        message: message
    });
};

module.exports = errorHandler;
