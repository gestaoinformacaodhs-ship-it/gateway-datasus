const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const logger = require('../config/logger');

class AuthController {
    static async register(req, res, next) {
        const { nome, email, senha, role } = req.body;
        try {
            const hash = await bcrypt.hash(senha, 10);
            const userRole = role === 'support' ? 'support' : 'user';
            
            await query("INSERT INTO usuarios (nome, email, senha, role) VALUES ($1, $2, $3, $4)", 
                [nome, email.toLowerCase().trim(), hash, userRole]);
            
            res.status(201).json({ success: true, message: "Usuário registrado com sucesso!" });
        } catch (err) {
            if (err.code === '23505') { // Unique violation
                return res.status(400).json({ success: false, error: "E-mail já cadastrado." });
            }
            next(err);
        }
    }

    static async listAttendants(req, res, next) {
        try {
            const result = await query("SELECT nome, email, role FROM usuarios WHERE role = 'support' OR role = 'master' ORDER BY nome ASC");
            res.json(result.rows);
        } catch (err) {
            next(err);
        }
    }

    static async deleteAttendant(req, res, next) {
        const { email } = req.body;
        try {
            // Prevent deleting master
            const check = await query("SELECT role FROM usuarios WHERE email = $1", [email]);
            if (check.rows[0] && check.rows[0].role === 'master') {
                return res.status(403).json({ success: false, error: "Não é possível remover o Administrador Master." });
            }

            await query("DELETE FROM usuarios WHERE email = $1", [email]);
            res.json({ success: true, message: "Atendente removido com sucesso." });
        } catch (err) {
            next(err);
        }
    }

    static async updateProfile(req, res, next) {
        const { nome, email, novaSenha } = req.body;
        // The user's authenticated email is in req.user.email (from authenticate middleware)
        const userEmail = req.user && req.user.email ? req.user.email : email;

        try {
            if (novaSenha && novaSenha.length >= 6) {
                const hash = await bcrypt.hash(novaSenha, 10);
                await query("UPDATE usuarios SET nome = $1, senha = $2 WHERE email = $3", [nome, hash, userEmail]);
            } else {
                await query("UPDATE usuarios SET nome = $1 WHERE email = $2", [nome, userEmail]);
            }
            res.json({ success: true, message: "Perfil atualizado com sucesso." });
        } catch (err) {
            next(err);
        }
    }

    static async deleteAccount(req, res, next) {
        const userEmail = req.user && req.user.email ? req.user.email : req.body.email;
        try {
            const check = await query("SELECT role FROM usuarios WHERE email = $1", [userEmail]);
            if (check.rows[0] && check.rows[0].role === 'master') {
                return res.status(403).json({ success: false, error: "O Administrador Master não pode excluir sua própria conta por aqui." });
            }

            await query("DELETE FROM usuarios WHERE email = $1", [userEmail]);
            res.json({ success: true, message: "Conta excluída com sucesso." });
        } catch (err) {
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
