const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const { Pool } = require('pg'); 
const { PassThrough } = require('stream');
const crypto = require('crypto');
const bcrypt = require('bcrypt'); // ADICIONADO: Segurança de senhas
const Brevo = require('@getbrevo/brevo');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURAÇÃO BREVO API ---
let apiInstance = new Brevo.TransactionalEmailsApi();
if (process.env.BREVO_API_KEY) {
    const defaultClient = Brevo.ApiClient.instance;
    const apiKey = defaultClient.authentications['api-key'];
    apiKey.apiKey = process.env.BREVO_API_KEY;
    console.log("✔️ API Brevo configurada com sucesso.");
}

// --- CONFIGURAÇÃO SUPABASE/POSTGRES ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome TEXT,
                email TEXT UNIQUE,
                senha TEXT,
                ativo INTEGER DEFAULT 0,
                token_ativacao TEXT
            );
            CREATE TABLE IF NOT EXISTS tokens (
                email TEXT,
                token TEXT PRIMARY KEY,
                expiracao TIMESTAMP
            );
        `);
        console.log("✔️ Banco de Dados pronto.");
    } catch (err) {
        console.error("❌ Erro ao inicializar Tabelas:", err.message);
    }
}
initDB();

const pastasFTP = { 'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 'FPO': '/siasus/FPO' };

async function enviarEmail(emailDestino, assunto, html) {
    try {
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = assunto;
        sendSmtpEmail.htmlContent = html;
        sendSmtpEmail.sender = { name: "Gateway SUS", email: "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ email: emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
    } catch (e) { console.error("Erro e-mail:", e.response?.body || e.message); }
}

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/register', async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ error: "Dados incompletos." });

    const emailLower = email.toLowerCase().trim();
    const token = crypto.randomBytes(20).toString('hex');

    try {
        // Criptografando a senha antes de salvar
        const salt = await bcrypt.genSalt(10);
        const senhaHash = await bcrypt.hash(senha, salt);

        await pool.query(
            `INSERT INTO usuarios (nome, email, senha, token_ativacao) VALUES ($1, $2, $3, $4)`,
            [nome, emailLower, senhaHash, token]
        );
        
        const link = `${req.protocol}://${req.get('host')}/api/activate?token=${token}`;
        await enviarEmail(emailLower, "Ative sua conta - Gateway SUS", `
            <h2>Olá, ${nome}!</h2>
            <p>Clique no link abaixo para ativar sua conta no sistema:</p>
            <a href="${link}">${link}</a>
        `);
        res.status(201).json({ message: "Verifique seu e-mail para ativar." });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: "E-mail já cadastrado ou erro no banco." });
    }
});

app.get('/api/activate', async (req, res) => {
    const { token } = req.query;
    try {
        const result = await pool.query(
            `UPDATE usuarios SET ativo = 1, token_ativacao = NULL WHERE token_ativacao = $1`,
            [token]
        );
        if (result.rowCount === 0) return res.status(400).send("Link inválido ou já utilizado.");
        res.send("<h1>Conta Ativada!</h1><p>Você será redirecionado para o login...</p><meta http-equiv='refresh' content='2;url=/index.html'>");
    } catch (err) { res.status(500).send("Erro na ativação."); }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();

    try {
        const result = await pool.query(
            `SELECT nome, email, senha, ativo FROM usuarios WHERE email = $1`,
            [emailLower]
        );
        const user = result.rows[0];

        if (!user) return res.status(401).json({ error: "Usuário não encontrado." });
        
        // Comparando senha criptografada
        const senhaValida = await bcrypt.compare(senha, user.senha);
        if (!senhaValida) return res.status(401).json({ error: "E-mail ou senha incorretos." });
        
        if (user.ativo === 0) return res.status(403).json({ error: "Sua conta ainda não foi ativada. Verifique seu e-mail." });
        
        res.json({ 
            user: user.nome, 
            email: user.email, 
            token: crypto.randomBytes(16).toString('hex') 
        });
    } catch (err) { res.status(500).json({ error: "Erro no servidor." }); }
});

// --- ROTA DE ATUALIZAÇÃO DE PERFIL (Para suportar profile.html) ---
app.put('/api/update-profile', async (req, res) => {
    const { nome, email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();

    try {
        if (senha) {
            const salt = await bcrypt.genSalt(10);
            const senhaHash = await bcrypt.hash(senha, salt);
            await pool.query(
                `UPDATE usuarios SET nome = $1, senha = $2 WHERE email = $3`,
                [nome, senhaHash, emailLower]
            );
        } else {
            await pool.query(
                `UPDATE usuarios SET nome = $1 WHERE email = $2`,
                [nome, emailLower]
            );
        }
        res.json({ message: "Perfil atualizado!" });
    } catch (err) {
        res.status(500).json({ error: "Erro ao atualizar perfil." });
    }
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    const emailLower = email.toLowerCase().trim();
    try {
        const user = await pool.query(`SELECT email FROM usuarios WHERE email = $1`, [emailLower]);
        if (user.rowCount === 0) return res.status(404).json({ error: "E-mail não encontrado." });

        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000); // 1 hora

        // Limpa tokens antigos antes de criar um novo
        await pool.query(`DELETE FROM tokens WHERE email = $1`, [emailLower]);
        await pool.query(
            `INSERT INTO tokens (email, token, expiracao) VALUES ($1, $2, $3)`,
            [emailLower, token, expiracao]
        );

        const link = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
        await enviarEmail(emailLower, "Recuperação de Senha - Gateway SUS", `
            <p>Você solicitou a redefinição de senha.</p>
            <p>Clique no link abaixo (válido por 1 hora):</p>
            <a href="${link}">Redefinir minha senha</a>
        `);
        res.json({ message: "E-mail de recuperação enviado!" });
    } catch (err) { res.status(500).json({ error: "Erro ao processar solicitação." }); }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, novaSenha } = req.body;
    try {
        const result = await pool.query(
            `SELECT email FROM tokens WHERE token = $1 AND expiracao > NOW()`, 
            [token]
        );
        const row = result.rows[0];

        if (!row) return res.status(400).json({ error: "Link inválido ou expirado." });
        
        const salt = await bcrypt.genSalt(10);
        const senhaHash = await bcrypt.hash(novaSenha, salt);

        await pool.query(`UPDATE usuarios SET senha = $1 WHERE email = $2`, [senhaHash, row.email]);
        await pool.query(`DELETE FROM tokens WHERE email = $1`, [row.email]);
        
        res.json({ message: "Senha atualizada com sucesso!" });
    } catch (err) { res.status(500).json({ error: "Erro ao salvar nova senha." }); }
});

// --- FTP DATASUS ---
app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        res.json(list.filter(f => f.isFile).map(f => ({ 
            name: f.name, 
            size: (f.size / 1024 / 1024).toFixed(2) + " MB" 
        })));
    } catch (e) { res.status(500).send("Erro ao listar arquivos FTP."); } 
    finally { client.close(); }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema.toUpperCase()]);
        res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
        const tunnel = new PassThrough();
        tunnel.pipe(res);
        await client.downloadTo(tunnel, decodeURIComponent(arquivo));
    } catch (e) { if (!res.headersSent) res.status(500).send("Erro no download."); } 
    finally { client.close(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gateway DATASUS rodando na porta ${PORT}`));