const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const logger = require('../config/logger');

class AuthController {
    static async register(req, res, next) {
        const { nome, email, senha } = req.body;
        try {
            const hash = await bcrypt.hash(senha, 10);
            await query("INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3)", 
                [nome, email.toLowerCase().trim(), hash]);
            
            res.status(201).json({ success: true, message: "Usuário registrado com sucesso!" });
        } catch (err) {
            if (err.code === '23505') { // Unique violation
                return res.status(400).json({ success: false, error: "E-mail já cadastrado." });
            }
            next(err);
        }
    }

    static async login(req, res, next) {
        const { email, senha } = req.body;
        try {
            const result = await query("SELECT * FROM usuarios WHERE email = $1", [email.toLowerCase().trim()]);
            const user = result.rows[0];

            if (user && await bcrypt.compare(senha, user.senha)) {
                const secret = process.env.JWT_SECRET;
                if (!secret && process.env.NODE_ENV === 'production') {
                    throw new Error('JWT_SECRET must be defined in production');
                }

                const token = jwt.sign(
                    { id: user.id, email: user.email, role: user.role }, 
                    secret || 'secret', 
                    { expiresIn: '12h' }
                );

                logger.info(`User login: ${user.email}`);
                return res.json({ 
                    success: true,
                    data: {
                        user: user.nome, 
                        email: user.email, 
                        role: user.role, 
                        token 
                    }
                });
            }
            res.status(401).json({ success: false, error: "Credenciais inválidas." });
        } catch (err) {
            next(err);
        }
    }
}

module.exports = AuthController;
