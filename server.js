const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
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

// --- BANCO DE DADOS (PERSISTÊNCIA) ---
// Se você configurar um Disk no Render, mude o caminho abaixo para o ponto de montagem
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (!err) {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                nome TEXT, 
                email TEXT UNIQUE, 
                senha TEXT, 
                ativo INTEGER DEFAULT 0, 
                token_ativacao TEXT
            )`);
            db.run(`CREATE TABLE IF NOT EXISTS tokens (email TEXT, token TEXT PRIMARY KEY, expiracao DATETIME)`);
            console.log("✔️ Banco de Dados pronto.");
        });
    }
});

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

// --- ROTAS ---

app.post('/api/register', (req, res) => {
    const { nome, email, senha } = req.body;
    const emailLower = email.toLowerCase().trim(); // Padronização
    const token = crypto.randomBytes(20).toString('hex');

    db.run(`INSERT INTO usuarios (nome, email, senha, token_ativacao) VALUES (?, ?, ?, ?)`, 
    [nome, emailLower, senha, token], function(err) {
        if (err) return res.status(400).json({ error: "E-mail já cadastrado." });
        
        const link = `${req.protocol}://${req.get('host')}/api/activate?token=${token}`;
        enviarEmail(emailLower, "Ative sua conta", `<a href="${link}">Clique para ativar</a>`);
        res.status(201).json({ message: "Verifique seu e-mail para ativar." });
    });
});

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();

    db.get(`SELECT nome, ativo FROM usuarios WHERE email = ? AND senha = ?`, [emailLower, senha], (err, row) => {
        if (err || !row) return res.status(401).json({ error: "E-mail ou senha incorretos." });
        if (row.ativo === 0) return res.status(403).json({ error: "Ative sua conta primeiro." });
        res.json({ user: row.nome });
    });
});

app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;
    const emailLower = email.toLowerCase().trim();

    db.get(`SELECT email FROM usuarios WHERE email = ?`, [emailLower], (err, user) => {
        if (!user) return res.status(404).json({ error: "E-mail não encontrado." });
        
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000).toISOString(); 

        db.run(`INSERT OR REPLACE INTO tokens (email, token, expiracao) VALUES (?, ?, ?)`, [emailLower, token, expiracao], () => {
            const link = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
            enviarEmail(emailLower, "Recuperar Senha", `<a href="${link}">Redefinir Senha</a>`);
            res.json({ message: "E-mail enviado!" });
        });
    });
});

app.post('/api/reset-password', (req, res) => {
    const { token, novaSenha } = req.body;
    
    // Verificação rigorosa do token e data
    db.get(`SELECT email FROM tokens WHERE token = ? AND expiracao > DATETIME('now')`, [token.trim()], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Link inválido ou expirado." });
        
        db.run(`UPDATE usuarios SET senha = ? WHERE email = ?`, [novaSenha, row.email], (err) => {
            if (err) return res.status(500).json({ error: "Erro ao salvar." });
            db.run(`DELETE FROM tokens WHERE email = ?`, [row.email]); // Limpa todos os tokens desse user
            res.json({ message: "Senha atualizada com sucesso!" });
        });
    });
});

// --- FTP E LISTAGEM ---
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
app.listen(PORT, () => console.log(`🚀 Gateway rodando na porta ${PORT}`));