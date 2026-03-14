const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const { Pool } = require('pg'); 
const { PassThrough } = require('stream');
const crypto = require('crypto');
const Brevo = require('@getbrevo/brevo');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURAÇÃO BREVO API ---
let apiInstance = new Brevo.TransactionalEmailsApi();
if (process.env.BREVO_API_KEY) {
    apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
    console.log("✔️ API Brevo configurada com sucesso.");
} else {
    console.warn("⚠️ BREVO_API_KEY não encontrada.");
}

// --- CONFIGURAÇÃO SUPABASE (CORRIGIDA) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { 
        // Isso ignora a verificação do certificado autoassinado e resolve o erro
        rejectUnauthorized: false 
    }
});

// Inicialização das tabelas no Supabase
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
        console.log("✔️ Banco de Dados Supabase conectado e tabelas prontas.");
    } catch (err) {
        console.error("❌ Erro ao conectar ao Supabase:", err.message);
    }
}
initDB();

const pastasFTP = { 'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 'FPO': '/siasus/FPO' };

// --- FUNÇÕES DE E-MAIL ---
async function enviarEmail(emailDestino, assunto, html) {
    try {
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = assunto;
        sendSmtpEmail.htmlContent = html;
        sendSmtpEmail.sender = { "name": "Gateway SUS", "email": "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ "email": emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
    } catch (e) { console.error("Erro e-mail:", e.message); }
}

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/register', async (req, res) => {
    const { nome, email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();
    const token = crypto.randomBytes(20).toString('hex');

    try {
        await pool.query(
            `INSERT INTO usuarios (nome, email, senha, token_ativacao) VALUES ($1, $2, $3, $4)`,
            [nome, emailLower, senha, token]
        );
        const link = `${req.protocol}://${req.get('host')}/api/activate?token=${token}`;
        await enviarEmail(emailLower, "Ative sua conta", `<a href="${link}">Clique aqui para ativar sua conta</a>`);
        res.status(201).json({ message: "Verifique seu e-mail para ativar." });
    } catch (err) {
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
        if (result.rowCount === 0) return res.status(400).send("Link inválido.");
        res.send("<h1>Conta Ativada!</h1><meta http-equiv='refresh' content='3;url=/index.html'>");
    } catch (err) { res.status(500).send("Erro na ativação."); }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();

    try {
        const result = await pool.query(
            `SELECT nome, ativo FROM usuarios WHERE email = $1 AND senha = $2`,
            [emailLower, senha]
        );
        const row = result.rows[0];

        if (!row) return res.status(401).json({ error: "E-mail ou senha incorretos." });
        if (row.ativo === 0) return res.status(403).json({ error: "Ative sua conta primeiro." });
        
        res.json({ user: row.nome });
    } catch (err) { res.status(500).json({ error: "Erro no servidor." }); }
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    const emailLower = email.toLowerCase().trim();

    try {
        const user = await pool.query(`SELECT email FROM usuarios WHERE email = $1`, [emailLower]);
        if (user.rowCount === 0) return res.status(404).json({ error: "E-mail não encontrado." });
        
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000); 

        // Uso do ON CONFLICT para atualizar o token se o usuário pedir reset várias vezes
        await pool.query(
            `INSERT INTO tokens (email, token, expiracao) VALUES ($1, $2, $3) 
             ON CONFLICT (token) DO UPDATE SET expiracao = $3`,
            [emailLower, token, expiracao]
        );

        const link = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
        await enviarEmail(emailLower, "Recuperar Senha", `<a href="${link}">Redefinir Senha</a>`);
        res.json({ message: "E-mail enviado!" });
    } catch (err) { res.status(500).json({ error: "Erro ao processar." }); }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, novaSenha } = req.body;
    try {
        const result = await pool.query(
            `SELECT email FROM tokens WHERE token = $1 AND expiracao > NOW()`,
            [token.trim()]
        );
        const row = result.rows[0];

        if (!row) return res.status(400).json({ error: "Link inválido ou expirado." });
        
        await pool.query(`UPDATE usuarios SET senha = $1 WHERE email = $2`, [novaSenha, row.email]);
        await pool.query(`DELETE FROM tokens WHERE email = $1`, [row.email]);
        res.json({ message: "Senha atualizada com sucesso!" });
    } catch (err) { res.status(500).json({ error: "Erro ao salvar nova senha." }); }
});

// --- FTP E LISTAGEM (DATASUS) ---

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    if (!pastasFTP[sistema]) return res.status(400).send("Inválido");
    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        res.json(list.filter(f => f.isFile).map(f => ({ name: f.name, size: (f.size / 1024 / 1024).toFixed(2) + " MB" })));
    } catch (e) { res.status(500).send("Erro FTP"); } 
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
    } catch (e) { if (!res.headersSent) res.status(500).send("Erro"); } 
    finally { client.close(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gateway DATASUS rodando na porta ${PORT}`));