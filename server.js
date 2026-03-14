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

// --- CONFIGURAÇÃO BREVO API (SOLUÇÃO DEFINITIVA PARA NODE 18) ---
let apiInstance;

try {
    // Busca a classe correta independente de como o pacote foi carregado
    const BrevoClass = Brevo.TransactionalEmailsApi || (Brevo.default && Brevo.default.TransactionalEmailsApi);
    
    if (!BrevoClass) throw new Error("Classe TransactionalEmailsApi não encontrada.");

    apiInstance = new BrevoClass();

    // Configura a chave de API que você mostrou na imagem
    if (process.env.BREVO_API_KEY) {
        // Tenta o método moderno primeiro
        if (Brevo.ApiClient && Brevo.ApiClient.instance) {
            const defaultClient = Brevo.ApiClient.instance;
            const apiKey = defaultClient.authentications['api-key'];
            apiKey.apiKey = process.env.BREVO_API_KEY;
        } else {
            // Fallback para o método setApiKey
            apiInstance.setApiKey(0, process.env.BREVO_API_KEY);
        }
        console.log("✔️ API Brevo conectada com a chave do Render.");
    }
} catch (error) {
    console.error("❌ Falha crítica ao iniciar Brevo:", error.message);
    // Cria um objeto vazio para o app não travar (Status 1)
    apiInstance = { sendTransacEmail: () => Promise.reject("Serviço de e-mail indisponível") };
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
        const EmailClass = Brevo.SendSmtpEmail || (Brevo.default && Brevo.default.SendSmtpEmail);
        const sendSmtpEmail = new EmailClass();

        sendSmtpEmail.subject = "Recuperação de Senha - Gateway SUS";
        sendSmtpEmail.htmlContent = `
            <div style="font-family:sans-serif; padding:20px; border:1px solid #3b82f6; border-radius:10px;">
                <h2 style="color:#3b82f6;">Gateway DATASUS</h2>
                <p>Recebemos um pedido de recuperação para sua conta.</p>
                <p>Clique no botão abaixo para criar uma nova senha:</p>
                <div style="text-align:center; margin:30px 0;">
                    <a href="${link}" style="background:#3b82f6; color:white; padding:12px 25px; text-decoration:none; border-radius:5px; font-weight:bold;">DEFINIR NOVA SENHA</a>
                </div>
                <hr style="border:0; border-top:1px solid #eee;">
                <small>Este link expira em 1 hora.</small>
            </div>`;
        sendSmtpEmail.sender = { "name": "Gateway SUS", "email": "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ "email": emailDestino }];

        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log("✅ E-mail enviado para:", emailDestino);
    } catch (error) {
        console.error("❌ Erro ao enviar e-mail:", error.message || error);
    }
}

// --- ROTAS DA API ---

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
        if (err || !user) return res.status(404).json({ error: "E-mail não cadastrado." });
        
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000).toISOString(); 

        db.run(`INSERT OR REPLACE INTO tokens (email, token, expiracao) VALUES (?, ?, ?)`, [email, token, expiracao], () => {
            const protocol = req.headers['x-forwarded-proto'] || 'http';
            const host = req.get('host');
            const link = `${protocol}://${host}/reset-password.html?token=${token}`;
            enviarEmailReal(email, link);
            res.json({ message: "Link de recuperação enviado!" });
        });
    });
});

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
    } catch (err) { res.status(500).send("Erro download"); }
    finally { client.close(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gateway DATASUS Online na porta ${PORT}`));