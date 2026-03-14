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
let apiInstance;

try {
    const defaultClient = Brevo.ApiClient.instance;
    const apiKey = defaultClient.authentications['api-key'];
    
    if (process.env.BREVO_API_KEY) {
        apiKey.apiKey = process.env.BREVO_API_KEY;
        apiInstance = new Brevo.TransactionalEmailsApi();
        console.log("✔️ API Brevo configurada com sucesso.");
    } else {
        console.warn("⚠️ BREVO_API_KEY não encontrada nas variáveis de ambiente.");
        apiInstance = { sendTransacEmail: () => Promise.reject("Chave de API ausente") };
    }
} catch (error) {
    console.error("❌ Erro ao iniciar Brevo:", error);
    apiInstance = { sendTransacEmail: () => Promise.reject("Serviço de e-mail indisponível") };
}

// --- BANCO DE DADOS ---
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
        });
        console.log("✔️ Banco de Dados pronto.");
    }
});

const pastasFTP = { 'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 'FPO': '/siasus/FPO' };

// --- FUNÇÕES DE ENVIO DE E-MAIL (COM TRATAMENTO DE ERRO MELHORADO) ---

async function enviarEmailRecuperacao(emailDestino, link) {
    try {
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = "Recuperação de Senha - Gateway SUS";
        sendSmtpEmail.htmlContent = `
            <div style="font-family:sans-serif; padding:20px; border:1px solid #3b82f6; border-radius:10px;">
                <h2 style="color:#3b82f6;">Gateway DATASUS</h2>
                <p>Clique no botão abaixo para definir sua nova senha:</p>
                <div style="text-align:center; margin:30px 0;">
                    <a href="${link}" style="background:#3b82f6; color:white; padding:12px 25px; text-decoration:none; border-radius:5px; font-weight:bold;">DEFINIR NOVA SENHA</a>
                </div>
                <small>Este link expira em 1 hora.</small>
            </div>`;
        sendSmtpEmail.sender = { "name": "Gateway SUS", "email": "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ "email": emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`✅ E-mail de recuperação enviado para: ${emailDestino}`);
    } catch (error) { 
        // Se o erro tiver uma resposta do Brevo, mostra o erro real, senão mostra o erro comum
        const erroReal = error.response ? JSON.stringify(error.response.body) : error.message;
        console.error("❌ Erro e-mail recuperação:", erroReal); 
    }
}

async function enviarEmailAtivacao(emailDestino, nome, link) {
    try {
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = "Ative sua conta - Gateway DATASUS";
        sendSmtpEmail.htmlContent = `
            <div style="font-family:sans-serif; padding:20px; border:1px solid #10b981; border-radius:10px;">
                <h2 style="color:#10b981;">Olá, ${nome}!</h2>
                <p>Para concluir seu cadastro e acessar o Gateway DATASUS, clique no botão abaixo para ativar sua conta:</p>
                <div style="text-align:center; margin:30px 0;">
                    <a href="${link}" style="background:#10b981; color:white; padding:12px 25px; text-decoration:none; border-radius:5px; font-weight:bold;">ATIVAR MINHA CONTA</a>
                </div>
                <p><small>Se você não solicitou este cadastro, ignore este e-mail.</small></p>
            </div>`;
        sendSmtpEmail.sender = { "name": "Gateway SUS", "email": "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ "email": emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`✅ E-mail de ativação enviado para: ${emailDestino}`);
    } catch (error) { 
        const erroReal = error.response ? JSON.stringify(error.response.body) : error.message;
        console.error("❌ Erro e-mail ativação:", erroReal); 
    }
}

// --- ROTAS DA API ---

app.post('/api/register', (req, res) => {
    const { nome, email, senha } = req.body;
    const tokenAtivacao = crypto.randomBytes(20).toString('hex');

    db.run(`INSERT INTO usuarios (nome, email, senha, token_ativacao, ativo) VALUES (?, ?, ?, ?, 0)`, 
    [nome, email, senha, tokenAtivacao], function(err) {
        if (err) return res.status(400).json({ error: "E-mail já cadastrado." });

        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.get('host');
        const link = `${protocol}://${host}/api/activate?token=${tokenAtivacao}`;

        enviarEmailAtivacao(email, nome, link);
        res.status(201).json({ message: "Cadastro realizado! Verifique seu e-mail para ativar a conta." });
    });
});

app.get('/api/activate', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send("Token ausente.");

    db.run(`UPDATE usuarios SET ativo = 1, token_ativacao = NULL WHERE token_ativacao = ?`, [token], function(err) {
        if (err || this.changes === 0) {
            return res.status(400).send("<h1>Link inválido ou conta já ativada.</h1>");
        }
        res.send(`
            <div style="font-family:sans-serif; text-align:center; margin-top:50px;">
                <h1 style="color:#10b981;">Conta Ativada!</h1>
                <p>Sua conta foi confirmada com sucesso. Redirecionando para o login...</p>
                <meta http-equiv="refresh" content="5;url=/index.html">
                <a href="/index.html" style="color:#3b82f6;">Clique aqui para ir ao Login agora</a>
            </div>
        `);
    });
});

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    db.get(`SELECT nome, ativo FROM usuarios WHERE email = ? AND senha = ?`, [email, senha], (err, row) => {
        if (err || !row) return res.status(401).json({ error: "E-mail ou senha incorretos." });
        
        if (row.ativo === 0) {
            return res.status(403).json({ error: "Sua conta ainda não foi ativada. Verifique seu e-mail." });
        }
        
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
            enviarEmailRecuperacao(email, link);
            res.json({ message: "Link de recuperação enviado!" });
        });
    });
});

app.post('/api/reset-password', (req, res) => {
    const { token, novaSenha } = req.body;
    db.get(`SELECT email FROM tokens WHERE token = ? AND expiracao > DATETIME('now')`, [token], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Link inválido ou expirado." });
        
        db.run(`UPDATE usuarios SET senha = ? WHERE email = ?`, [novaSenha, row.email], (updateErr) => {
            if (updateErr) return res.status(500).json({ error: "Erro ao atualizar a senha." });
            db.run(`DELETE FROM tokens WHERE token = ?`, [token]);
            res.json({ message: "Senha atualizada com sucesso!" });
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
        res.json(list.filter(f => f.isFile).map(f => ({ 
            name: f.name, 
            size: (f.size / 1024 / 1024).toFixed(2) + " MB" 
        })));
    } catch (err) { 
        console.error("Erro FTP List:", err);
        res.status(500).json({ error: "Não foi possível listar arquivos do DATASUS." }); 
    }
    finally { client.close(); }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const nomeArquivo = decodeURIComponent(arquivo);
    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema.toUpperCase()]);
        
        res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
        const tunnel = new PassThrough();
        tunnel.pipe(res);
        
        await client.downloadTo(tunnel, nomeArquivo);
    } catch (err) { 
        console.error("Erro FTP Download:", err);
        if (!res.headersSent) res.status(500).send("Erro ao processar download."); 
    }
    finally { client.close(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gateway DATASUS Online na porta ${PORT}`));