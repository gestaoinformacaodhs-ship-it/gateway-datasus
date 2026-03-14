const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { PassThrough } = require('stream');
const crypto = require('crypto');
const SibApiV3Sdk = require('@getbrevo/brevo');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURAÇÃO BREVO API (SINTAXE ROBUSTA) ---
// Tentamos acessar a classe TransactionalEmailsApi de forma direta
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// Configuração da chave de API usando o método setApiKey
if (process.env.BREVO_API_KEY) {
    apiInstance.setApiKey(SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
    console.log("✅ Configuração da API Brevo carregada.");
} else {
    console.error("⚠️ BREVO_API_KEY não definida no ambiente.");
}

// --- BANCO DE DADOS ---
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("❌ Erro no banco:", err);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, email TEXT UNIQUE, senha TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS tokens (email TEXT, token TEXT PRIMARY KEY, expiracao DATETIME)`, 
        () => console.log("✔️ Banco de Dados pronto."));
    }
});

const pastasFTP = { 'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 'FPO': '/siasus/FPO' };

// --- FUNÇÃO DE ENVIO ---
async function enviarEmailReal(emailDestino, link) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    sendSmtpEmail.subject = "Recuperação de Senha - Gateway SUS";
    sendSmtpEmail.htmlContent = `
        <div style="font-family: sans-serif; padding: 20px;">
            <h2>Recuperação de Senha</h2>
            <p>Clique no botão abaixo para definir sua nova senha:</p>
            <a href="${link}" style="background-color: #3b82f6; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px;">CRIAR NOVA SENHA</a>
        </div>`;
    
    sendSmtpEmail.sender = { "name": "Gateway SUS", "email": "gestaoinformacaodhs@gmail.com" };
    sendSmtpEmail.to = [{ "email": emailDestino }];

    try {
        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log("✅ E-mail enviado com sucesso!");
    } catch (error) {
        console.error("❌ Erro no envio do e-mail:", error.message);
    }
}

// --- ROTAS ---
app.post('/api/register', (req, res) => {
    const { nome, email, senha } = req.body;
    db.run(`INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)`, [nome, email, senha], (err) => {
        if (err) return res.status(400).json({ error: "E-mail já cadastrado." });
        res.status(201).json({ message: "Usuário criado" });
    });
});

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    db.get(`SELECT nome FROM usuarios WHERE email = ? AND senha = ?`, [email, senha], (err, row) => {
        if (err || !row) return res.status(401).json({ error: "Credenciais inválidas." });
        res.json({ user: row.nome });
    });
});

app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;
    db.get(`SELECT email FROM usuarios WHERE email = ?`, [email], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "E-mail não encontrado." });
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000).toISOString(); 
        db.run(`INSERT OR REPLACE INTO tokens (email, token, expiracao) VALUES (?, ?, ?)`, [email, token, expiracao], () => {
            const protocol = req.headers['x-forwarded-proto'] || 'http';
            const link = `${protocol}://${req.get('host')}/reset-password.html?token=${token}`;
            enviarEmailReal(email, link);
            res.json({ message: "Instruções enviadas!" });
        });
    });
});

app.post('/api/reset-password', (req, res) => {
    const { token, novaSenha } = req.body;
    db.get(`SELECT email FROM tokens WHERE token = ? AND expiracao > datetime('now')`, [token], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Link inválido." });
        db.run(`UPDATE usuarios SET senha = ? WHERE email = ?`, [novaSenha, row.email], () => {
            db.run(`DELETE FROM tokens WHERE token = ?`, [token]);
            res.json({ message: "Senha atualizada!" });
        });
    });
});

// --- FTP ---
app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        res.json(list.filter(f => f.isFile).map(f => ({ name: f.name, size: (f.size / 1024 / 1024).toFixed(2) + " MB" })));
    } catch (err) { res.status(500).json({ error: "Erro FTP" }); }
    finally { client.close(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gateway DATASUS Online na porta ${PORT}`));