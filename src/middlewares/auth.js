const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

/**
 * JWT Authentication middleware.
 */
const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, error: 'Access token missing' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        req.user = decoded;
        next();
    } catch (err) {
        logger.warn('Invalid token attempt:', err.message);
        return res.status(403).json({ success: false, error: 'Invalid or expired token' });
    }
};

/**
 * Role-based authorization middleware.
 */
const authorize = (roles = []) => {
    if (typeof roles === 'string') {
        roles = [roles];
    }

    return (req, res, next) => {
        if (!req.user || (roles.length && !roles.includes(req.user.role))) {
            return res.status(403).json({ success: false, error: 'Insufficient permissions' });
        }
        next();
    };
};

module.exports = { authenticate, authorize };
