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
    connectionTimeoutMillis: 5000 // Timeout de 5s para não travar o servidor
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
            <div style="font-family: sans-serif; padding: 20px; color: #333;">
                <h2>Olá, ${nome}!</h2>
                <p>Clique no botão abaixo para ativar sua conta no Gateway SUS:</p>
                <a href="${link}" style="background: #3b82f6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Ativar Minha Conta</a>
                <p style="margin-top: 20px; font-size: 0.8em; color: #666;">Se o botão não funcionar, copie o link: ${link}</p>
            </div>
        `);
        res.status(201).json({ message: "Verifique seu e-mail para ativar." });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: "Este e-mail já está cadastrado." });
        }
        console.error(err);
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
        const result = await pool.query(
            `SELECT nome, email, senha, ativo FROM usuarios WHERE email = $1`,
            [emailLower]
        );
        const user = result.rows[0];

        if (!user) return res.status(401).json({ error: "E-mail ou senha incorretos." });
        
        const senhaValida = await bcrypt.compare(senha, user.senha);
        if (!senhaValida) return res.status(401).json({ error: "E-mail ou senha incorretos." });
        
        if (user.ativo === 0) return res.status(403).json({ error: "Por favor, ative sua conta no e-mail." });
        
        // Retornamos o nome e email para salvar no localStorage
        res.json({ 
            user: user.nome, 
            email: user.email, 
            token: crypto.randomBytes(32).toString('hex') 
        });
    } catch (err) { res.status(500).json({ error: "Erro no servidor." }); }
});

// --- FTP LOGIC ---

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    if (!pastasFTP[sistema]) return res.status(400).send("Sistema inválido.");

    const client = new ftp.Client(15000); // Timeout de 15s
    try {
        await client.access({ 
            host: "arpoador.datasus.gov.br", 
            user: "anonymous", 
            password: "guest",
            secure: false 
        });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        
        // Filtra apenas arquivos e formata o tamanho
        const result = list
            .filter(f => f.isFile)
            .map(f => ({ 
                name: f.name, 
                size: (f.size / 1024 / 1024).toFixed(2) + " MB" 
            }));
        
        res.json(result);
    } catch (e) { 
        console.error("Erro FTP List:", e.message);
        res.status(500).json({ error: "Erro ao conectar ao FTP do DATASUS." }); 
    } finally { 
        client.close(); 
    }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const sistemaUpper = sistema.toUpperCase();
    
    if (!pastasFTP[sistemaUpper]) return res.status(400).send("Sistema inválido.");

    const client = new ftp.Client(30000); // Timeout maior para downloads
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistemaUpper]);
        
        res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
        res.setHeader('Content-Type', 'application/octet-stream');

        const tunnel = new PassThrough();
        tunnel.pipe(res);

        await client.downloadTo(tunnel, decodeURIComponent(arquivo));
    } catch (e) { 
        console.error("Erro FTP Download:", e.message);
        if (!res.headersSent) res.status(500).send("Erro ao baixar arquivo."); 
    } finally { 
        client.close(); 
    }
});

// Rotas de Perfil (Opcional, mas útil)
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