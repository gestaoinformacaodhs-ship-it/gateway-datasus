const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const { Pool } = require('pg'); 
const { PassThrough } = require('stream');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Brevo = require('@getbrevo/brevo');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURAÇÃO BREVO API ---
let apiInstance = new Brevo.TransactionalEmailsApi();
if (process.env.BREVO_API_KEY) {
    apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
    console.log("✔️ API Brevo configurada com sucesso.");
}

// --- CONFIGURAÇÃO SUPABASE/POSTGRES ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000 
});

async function initDB() {
    try {
        // 1. Cria a tabela base se não existir
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome TEXT,
                email TEXT UNIQUE,
                senha TEXT,
                ativo INTEGER DEFAULT 0,
                token_ativacao TEXT
            );
        `);

        // 2. Garante que as colunas de recuperação de senha existam (Evita erro 500)
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token TEXT`);
        await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_expiracao TIMESTAMP`);
        
        console.log("✔️ Banco de Dados pronto e atualizado.");
    } catch (err) {
        console.error("❌ Erro ao inicializar/atualizar Tabelas:", err.message);
    }
}
initDB();

const pastasFTP = { 
    'BPA': '/siasus/BPA', 
    'SIA': '/siasus/SIA', 
    'RAAS': '/siasus/RAAS', 
    'FPO': '/siasus/FPO' 
};

async function enviarEmail(emailDestino, assunto, html) {
    try {
        if (!process.env.BREVO_API_KEY) {
            console.warn("⚠️ E-mail não enviado: BREVO_API_KEY ausente.");
            return;
        }
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = assunto;
        sendSmtpEmail.htmlContent = html;
        sendSmtpEmail.sender = { name: "Gateway SUS", email: "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ email: emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
    } catch (e) { 
        console.error("Erro e-mail:", e.response?.body || e.message); 
    }
}

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/register', async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ error: "Dados incompletos." });

    const emailLower = email.toLowerCase().trim();
    const token = crypto.randomBytes(20).toString('hex');

    try {
        const salt = await bcrypt.genSalt(10);
        const senhaHash = await bcrypt.hash(senha, salt);

        await pool.query(
            `INSERT INTO usuarios (nome, email, senha, token_ativacao) VALUES ($1, $2, $3, $4)`,
            [nome, emailLower, senhaHash, token]
        );
        
        const link = `${req.protocol}://${req.get('host')}/api/activate?token=${token}`;
        await enviarEmail(emailLower, "Ative sua conta - Gateway SUS", `
            <div style="font-family: sans-serif; padding: 20px; color: #333; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #3b82f6;">Olá, ${nome}!</h2>
                <p>Clique no botão abaixo para ativar sua conta no Gateway SUS:</p>
                <a href="${link}" style="background: #3b82f6; color: white; padding: 12px 25px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">Ativar Minha Conta</a>
                <p style="margin-top: 20px; font-size: 0.8em; color: #666;">Se o botão não funcionar, copie o link: <br> ${link}</p>
            </div>
        `);
        res.status(201).json({ message: "Verifique seu e-mail para ativar." });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: "Este e-mail já está cadastrado." });
        res.status(500).json({ error: "Erro interno no servidor." });
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
        res.send("<h1>Conta Ativada!</h1><p>Redirecionando...</p><meta http-equiv='refresh' content='2;url=/index.html'>");
    } catch (err) { res.status(500).send("Erro na ativação."); }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();

    try {
        const result = await pool.query(`SELECT nome, email, senha, ativo FROM usuarios WHERE email = $1`, [emailLower]);
        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(senha, user.senha))) {
            return res.status(401).json({ error: "E-mail ou senha incorretos." });
        }
        
        if (user.ativo === 0) return res.status(403).json({ error: "Por favor, ative sua conta no e-mail." });
        
        res.json({ 
            user: user.nome, 
            email: user.email, 
            token: crypto.randomBytes(32).toString('hex') 
        });
    } catch (err) { res.status(500).json({ error: "Erro no servidor." }); }
});

// --- ROTA: SOLICITAR RECUPERAÇÃO ---
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    const emailLower = email.toLowerCase().trim();

    try {
        const user = await pool.query("SELECT nome FROM usuarios WHERE email = $1", [emailLower]);
        
        if (user.rowCount === 0) {
            return res.json({ message: "Se o e-mail estiver cadastrado, você receberá as instruções." });
        }

        const token = crypto.randomBytes(20).toString('hex');
        // Define a expiração para 1 hora a partir de agora no fuso do servidor
        const expiracao = new Date(Date.now() + 3600000); 

        await pool.query(
            "UPDATE usuarios SET reset_token = $1, reset_expiracao = $2 WHERE email = $3",
            [token, expiracao, emailLower]
        );

        const link = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
        
        await enviarEmail(emailLower, "Recuperação de Senha - Gateway SUS", `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee;">
                <h2 style="color: #ef4444;">Recuperar Senha</h2>
                <p>Olá, ${user.rows[0].nome}.</p>
                <p>Clique no link abaixo para criar uma nova senha (válido por 1 hora):</p>
                <a href="${link}" style="background: #1e293b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Redefinir Senha</a>
            </div>
        `);

        res.json({ message: "E-mail de recuperação enviado!" });
    } catch (err) {
        console.error("Erro forgot-pass:", err);
        res.status(500).json({ error: "Erro ao processar solicitação." });
    }
});

// --- ROTA: DEFINIR NOVA SENHA (AJUSTADA PARA FUSO HORÁRIO) ---
app.post('/api/reset-password', async (req, res) => {
    const { token, novaSenha } = req.body;

    try {
        // Usamos CURRENT_TIMESTAMP do banco para evitar conflitos de fuso horário entre App e DB
        const result = await pool.query(
            "SELECT email FROM usuarios WHERE reset_token = $1 AND reset_expiracao > CURRENT_TIMESTAMP",
            [token]
        );

        if (result.rowCount === 0) return res.status(400).json({ error: "Token inválido ou expirado." });

        const email = result.rows[0].email;
        const salt = await bcrypt.genSalt(10);
        const senhaHash = await bcrypt.hash(novaSenha, salt);

        await pool.query(
            "UPDATE usuarios SET senha = $1, reset_token = NULL, reset_expiracao = NULL WHERE email = $2",
            [senhaHash, email]
        );

        res.json({ message: "Senha alterada com sucesso!" });
    } catch (err) {
        console.error("Erro reset-pass:", err);
        res.status(500).json({ error: "Erro ao redefinir senha." });
    }
});

// --- FTP LOGIC ---

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    if (!pastasFTP[sistema]) return res.status(400).send("Sistema inválido.");

    const client = new ftp.Client(15000); 
    try {
        await client.access({ 
            host: "arpoador.datasus.gov.br", 
            user: "anonymous", 
            password: "guest",
            secure: false 
        });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        
        const result = list
            .filter(f => f.isFile)
            .map(f => ({ 
                name: f.name, 
                size: (f.size / 1024 / 1024).toFixed(2) + " MB" 
            }));
        
        res.json(result);
    } catch (e) { 
        res.status(500).json({ error: "Erro ao conectar ao FTP do DATASUS." }); 
    } finally { 
        client.close(); 
    }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const sistemaUpper = sistema.toUpperCase();
    if (!pastasFTP[sistemaUpper]) return res.status(400).send("Sistema inválido.");

    const client = new ftp.Client(30000);
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistemaUpper]);
        
        res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
        res.setHeader('Content-Type', 'application/octet-stream');

        const tunnel = new PassThrough();
        tunnel.pipe(res);
        await client.downloadTo(tunnel, decodeURIComponent(arquivo));
    } catch (e) { 
        if (!res.headersSent) res.status(500).send("Erro ao baixar arquivo."); 
    } finally { 
        client.close(); 
    }
});

app.put('/api/update-profile', async (req, res) => {
    const { nome, email, senha } = req.body;
    try {
        if (senha) {
            const salt = await bcrypt.genSalt(10);
            const senhaHash = await bcrypt.hash(senha, salt);
            await pool.query(`UPDATE usuarios SET nome = $1, senha = $2 WHERE email = $3`, [nome, senhaHash, email]);
        } else {
            await pool.query(`UPDATE usuarios SET nome = $1 WHERE email = $2`, [nome, email]);
        }
        res.json({ message: "Perfil atualizado!" });
    } catch (err) { res.status(500).json({ error: "Erro ao atualizar." }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Gateway DATASUS Online na porta ${PORT}`);
});