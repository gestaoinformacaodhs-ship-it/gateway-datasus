const express = require('express');
const { body } = require('express-validator');
const AuthController = require('../controllers/authController');
const ProxyController = require('../controllers/proxyController');
const FtpController = require('../controllers/ftpController');
const { validate } = require('../middlewares/validation');
const { authenticate } = require('../middlewares/auth');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate limiters
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 20, 
    message: { success: false, error: 'Muitas tentativas. Tente novamente mais tarde.' },
});

const downloadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, 
    max: 100, 
    message: { success: false, error: 'Limite de downloads atingido. Aguarde 1 hora.' },
});

// Health check
router.get('/health', (req, res) => res.status(200).json({ status: 'OK', timestamp: new Date() }));

// Auth Routes
router.post('/registrar', 
    authLimiter,
    [
        body('nome').notEmpty().withMessage('Nome é obrigatório'),
        body('email').isEmail().withMessage('E-mail inválido'),
        body('senha').isLength({ min: 6 }).withMessage('Senha deve ter no mínimo 6 caracteres')
    ],
    validate,
    AuthController.register
);

router.post('/login', 
    authLimiter,
    [
        body('email').isEmail().withMessage('E-mail inválido'),
        body('senha').notEmpty().withMessage('Senha é obrigatória')
    ],
    validate,
    AuthController.login
);

// Proxy Routes (Authenticated)
router.all('/sia-proxy', authenticate, ProxyController.handleProxy);
router.all('/sihd-proxy', authenticate, ProxyController.handleProxy);

// FTP Routes (Authenticated)
router.get('/list/:sistema', authenticate, FtpController.list);
router.get('/download/:sistema/:arquivo', authenticate, downloadLimiter, FtpController.download);

// Admin Management (Requires Authentication)
router.get('/admin/atendentes', authenticate, AuthController.listAttendants);
router.post('/admin/deletar-atendente', authenticate, AuthController.deleteAttendant);

// User Profile Management (Requires Authentication)
router.post('/update-profile', authenticate, AuthController.updateProfile);
router.post('/delete-account', authenticate, AuthController.deleteAccount);

module.exports = router;