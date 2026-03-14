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

// --- CONFIGURAÇÃO SUPABASE/POSTGRES ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
    console.error('❌ Erro inesperado no cliente PostgreSQL:', err.message);
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
        console.log("✔️ Banco de Dados conectado e tabelas prontas.");
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

// --- FUNÇÕES AUXILIARES ---
async function enviarEmail(emailDestino, assunto, html) {
    try {
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = assunto;
        sendSmtpEmail.htmlContent = html;
        sendSmtpEmail.sender = { "name": "Gateway SUS", "email": "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ "email": emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
    } catch (e) { 
        console.error("Erro ao enviar e-mail:", e.message); 
    }
}

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/register', async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ error: "Dados incompletos." });

    const emailLower = email.toLowerCase().trim();
    const token = crypto.randomBytes(20).toString('hex');

    try {
        await pool.query(
            `INSERT INTO usuarios (nome, email, senha, token_ativacao) VALUES ($1, $2, $3, $4)`,
            [nome, emailLower, senha, token]
        );
        const link = `${req.protocol}://${req.get('host')}/api/activate?token=${token}`;
        await enviarEmail(emailLower, "Ative sua conta - Gateway SUS", `<p>Olá ${nome}, clique no link para ativar sua conta: <a href="${link}">${link}</a></p>`);
        res.status(201).json({ message: "Cadastro realizado! Verifique seu e-mail para ativar." });
    } catch (err) {
        res.status(400).json({ error: "E-mail já cadastrado ou erro interno." });
    }
});

app.get('/api/activate', async (req, res) => {
    const { token } = req.query;
    try {
        const result = await pool.query(
            `UPDATE usuarios SET ativo = 1, token_ativacao = NULL WHERE token_ativacao = $1`,
            [token]
        );
        if (result.rowCount === 0) return res.status(400).send("Link de ativação expirado ou inválido.");
        res.send("<h1>Conta Ativada!</h1><p>Redirecionando...</p><meta http-equiv='refresh' content='3;url=/index.html'>");
    } catch (err) { 
        res.status(500).send("Erro interno na ativação."); 
    }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();

    try {
        const result = await pool.query(
            `SELECT nome, email, ativo FROM usuarios WHERE email = $1 AND senha = $2`,
            [emailLower, senha]
        );
        const row = result.rows[0];

        if (!row) return res.status(401).json({ error: "E-mail ou senha incorretos." });
        if (row.ativo === 0) return res.status(403).json({ error: "Sua conta ainda não foi ativada. Verifique seu e-mail." });
        
        // Em produção, use JWT aqui. Por enquanto, retornamos o 'fake-token' para seu front-end funcionar.
        res.json({ 
            user: row.nome, 
            email: row.email, 
            token: 'session_' + crypto.randomBytes(8).toString('hex') 
        });
    } catch (err) { 
        res.status(500).json({ error: "Erro no servidor ao tentar logar." }); 
    }
});

app.put('/api/update-profile', async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!email) return res.status(400).json({ error: "E-mail é obrigatório para atualizar." });

    try {
        let result;
        if (senha && senha.trim() !== "") {
            result = await pool.query(
                "UPDATE usuarios SET nome = $1, senha = $2 WHERE email = $3",
                [nome, senha, email]
            );
        } else {
            result = await pool.query(
                "UPDATE usuarios SET nome = $1 WHERE email = $2",
                [nome, email]
            );
        }

        if (result.rowCount > 0) {
            res.json({ message: "Perfil atualizado com sucesso!" });
        } else {
            res.status(404).json({ error: "Usuчныйário não encontrado." });
        }
    } catch (err) {
        console.error("Erro Update Profile:", err.message);
        res.status(500).json({ error: "Erro ao atualizar dados." });
    }
});

// --- LISTAGEM E DOWNLOAD (DATASUS) ---

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    if (!pastasFTP[sistema]) return res.status(400).send("Sistema inválido.");
    
    const client = new ftp.Client();
    client.ftp.verbose = false; // Mantenha false para não poluir o log

    try {
        await client.access({ 
            host: "arpoador.datasus.gov.br", 
            user: "anonymous", 
            password: "guest",
            secure: false 
        });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        
        const files = list
            .filter(f => f.isFile)
            .map(f => ({ 
                name: f.name, 
                size: (f.size / 1024 / 1024).toFixed(2) + " MB" 
            }));
            
        res.json(files);
    } catch (e) { 
        console.error("Erro FTP List:", e.message);
        res.status(500).json({ error: "Não foi possível conectar ao Arpoador." }); 
    } finally { 
        client.close(); 
    }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const pasta = pastasFTP[sistema.toUpperCase()];
    if (!pasta) return res.status(400).send("Caminho inválido.");

    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pasta);
        
        res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
        const tunnel = new PassThrough();
        tunnel.pipe(res);
        
        // decodeURIComponent garante que espaços no nome do arquivo não quebrem o download
        await client.downloadTo(tunnel, decodeURIComponent(arquivo));
    } catch (e) { 
        console.error("Erro no Download FTP:", e.message);
        if (!res.headersSent) res.status(500).send("Erro ao processar arquivo."); 
    } finally { 
        client.close(); 
    }
});

app.post('/api/logout', (req, res) => {
    res.json({ message: "Sessão encerrada com sucesso." });
});

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Gateway DATASUS Ativo`);
    console.log(`📡 Porta: ${PORT}`);
});