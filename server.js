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

// --- CONFIGURAÇÃO BREVO API (SOLUÇÃO PARA STATUS 1) ---
let apiInstance;

try {
    // Verifica se a classe existe no objeto principal ou dentro de .default (comum no Render)
    const BrevoClass = Brevo.TransactionalEmailsApi || (Brevo.default && Brevo.default.TransactionalEmailsApi);
    
    if (!BrevoClass) {
        throw new Error("Não foi possível encontrar a classe TransactionalEmailsApi no pacote.");
    }

    apiInstance = new BrevoClass();

    // Configuração da chave de API
    if (process.env.BREVO_API_KEY) {
        // Tenta configurar pelo ApiClient primeiro (método oficial mais recente)
        if (Brevo.ApiClient && Brevo.ApiClient.instance) {
            const defaultClient = Brevo.ApiClient.instance;
            const apiKey = defaultClient.authentications['api-key'];
            apiKey.apiKey = process.env.BREVO_API_KEY;
        } else {
            // Método alternativo direto na instância
            apiInstance.setApiKey(0, process.env.BREVO_API_KEY);
        }
        console.log("✔️ Configuração da API Brevo carregada.");
    } else {
        console.error("⚠️ Alerta: BREVO_API_KEY não encontrada no ambiente.");
    }
} catch (error) {
    console.error("❌ Erro ao inicializar API Brevo:", error.message);
    // Criamos um objeto fake para não derrubar o servidor se a API falhar
    apiInstance = { sendTransacEmail: () => console.error("API Brevo não inicializada.") };
}

// --- BANCO DE DADOS ---
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (!err) {
        db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, email TEXT UNIQUE, senha TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS tokens (email TEXT, token TEXT PRIMARY KEY, expiracao DATETIME)`, 
        () => console.log("✔️ Banco de Dados pronto."));
    }
});

const pastasFTP = { 'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 'FPO': '/siasus/FPO' };

// --- FUNÇÃO DE ENVIO ---
async function enviarEmailReal(emailDestino, link) {
    try {
        const sendSmtpEmail = new (Brevo.SendSmtpEmail || Brevo.default.SendSmtpEmail)();
        sendSmtpEmail.subject = "Recuperação de Senha - Gateway SUS";
        sendSmtpEmail.htmlContent = `
            <div style="font-family:sans-serif; padding:20px; border:1px solid #eee; border-radius:10px;">
                <h2 style="color:#3b82f6;">Recuperação de Senha</h2>
                <p>Você solicitou a alteração de senha do Gateway DATASUS.</p>
                <p>Clique no link abaixo para prosseguir:</p>
                <a href="${link}" style="background:#3b82f6; color:white; padding:10px 20px; text-decoration:none; border-radius:5px; display:inline-block;">ALTERAR SENHA</a>
                <br><br><small>Se você não solicitou isso, ignore este e-mail.</small>
            </div>`;
        sendSmtpEmail.sender = { "name": "Gateway SUS", "email": "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ "email": emailDestino }];

        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log("✅ E-mail de recuperação enviado para:", emailDestino);
    } catch (error) {
        console.error("❌ Falha no envio do e-mail:", error.message);
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
        if (err || !row) return res.status(401).json({ error: "E-mail ou senha incorretos." });
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

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    const client = new ftp.Client();
    client.ftp.verbose = false;
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        res.json(list.filter(f => f.isFile).map(f => ({ name: f.name, size: (f.size / 1024 / 1024).toFixed(2) + " MB" })));
    } catch (err) { res.status(500).json({ error: "Erro ao conectar ao FTP do DATASUS" }); }
    finally { client.close(); }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema.toUpperCase()]);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(arquivo)}"`);
        const tunnel = new PassThrough();
        tunnel.pipe(res);
        await client.downloadTo(tunnel, arquivo);
    } catch (err) { res.status(500).send("Erro no download via FTP"); }
    finally { client.close(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gateway DATASUS Online na porta ${PORT}`));