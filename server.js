const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const { Pool } = require('pg'); 
const { PassThrough } = require('stream');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Brevo = require('@getbrevo/brevo');

// --- IMPORTS PARA O CHAT ---
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app); 
const io = new Server(server); 

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
        // Tabela de Usuários
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome TEXT,
                email TEXT UNIQUE,
                senha TEXT,
                ativo INTEGER DEFAULT 0,
                token_ativacao TEXT,
                reset_token TEXT,
                reset_expiracao TIMESTAMP
            );
        `);

        // Tabela: Mensagens do Suporte
        await pool.query(`
            CREATE TABLE IF NOT EXISTS mensagens_suporte (
                id SERIAL PRIMARY KEY,
                usuario TEXT,
                texto TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("✔️ Banco de Dados pronto (Tabelas e Chat).");
    } catch (err) {
        console.error("❌ Erro ao inicializar/atualizar Tabelas:", err.message);
    }
}
initDB();

// --- LÓGICA DO CHAT (SOCKET.IO) ---
io.on('connection', async (socket) => {
    console.log('🔌 Novo usuário conectado ao suporte:', socket.id);

    try {
        const historico = await pool.query(
            "SELECT usuario, texto FROM mensagens_suporte ORDER BY timestamp ASC LIMIT 50"
        );
        socket.emit('historico_mensagens', historico.rows);
    } catch (err) {
        console.error("Erro ao carregar histórico:", err.message);
    }

    socket.on('enviar_mensagem', async (data) => {
        const { nome, mensagem } = data;
        try {
            await pool.query(
                "INSERT INTO mensagens_suporte (usuario, texto) VALUES ($1, $2)",
                [nome, mensagem]
            );
            io.emit('receber_mensagem', {
                usuario: nome,
                texto: mensagem,
                hora: new Date().toLocaleTimeString()
            });
        } catch (err) {
            console.error("Erro ao salvar mensagem:", err.message);
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Usuário desconectou do suporte.');
    });
});

// --- FUNÇÃO AUXILIAR DE E-MAIL (BREVO) ---
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

// --- ROTA DE RECUPERAÇÃO DE SENHA ADMIN (NOVA) ---
app.post('/api/recuperar-senha-admin', async (req, res) => {
    const { email } = req.body;
    const emailLower = email.toLowerCase().trim();

    // Segurança: Defina aqui o seu e-mail de admin autorizado
    const EMAIL_ADMIN_AUTORIZADO = "gestaoinformacaodhs@gmail.com"; 

    if (emailLower !== EMAIL_ADMIN_AUTORIZADO) {
        // Por segurança, não confirmamos se o e-mail é o correto ou não
        return res.json({ success: true, message: "Se o e-mail for o administrador, você receberá a senha." });
    }

    const senhaMestra = "2024"; // Sua senha configurada no admin-login.html

    const conteudoHtml = `
        <div style="font-family: sans-serif; background: #0f172a; color: white; padding: 40px; border-radius: 20px; border: 1px solid #1e293b;">
            <h2 style="color: #3b82f6; text-align: center;">CONSOLE ADMIN</h2>
            <p style="text-align: center; color: #94a3b8;">Você solicitou a recuperação da senha de acesso ao suporte.</p>
            <div style="background: #1e293b; padding: 30px; border-radius: 15px; border: 2px dashed #3b82f6; text-align: center; margin: 20px 0;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #fff;">${senhaMestra}</span>
            </div>
            <p style="font-size: 12px; color: #64748b; text-align: center;">Use esta senha na página admin-login.html</p>
        </div>
    `;

    try {
        await enviarEmail(emailLower, "🔒 Senha de Acesso Administrador", conteudoHtml);
        res.json({ success: true, message: "E-mail enviado!" });
    } catch (error) {
        res.status(500).json({ success: false, error: "Erro ao disparar e-mail." });
    }
});

// --- ROTAS DE USUÁRIO (REGISTER / LOGIN / RESET) ---

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
        const result = await pool.query(`UPDATE usuarios SET ativo = 1, token_ativacao = NULL WHERE token_ativacao = $1`, [token]);
        if (result.rowCount === 0) return res.status(400).send("Link inválido.");
        res.send("<h1>Conta Ativada!</h1><p>Redirecionando...</p><meta http-equiv='refresh' content='2;url=/index.html'>");
    } catch (err) { res.status(500).send("Erro na ativação."); }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();
    try {
        const result = await pool.query(`SELECT nome, email, senha, ativo FROM usuarios WHERE email = $1`, [emailLower]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(senha, user.senha))) return res.status(401).json({ error: "E-mail ou senha incorretos." });
        if (user.ativo === 0) return res.status(403).json({ error: "Ative sua conta no e-mail." });
        res.json({ user: user.nome, email: user.email, token: crypto.randomBytes(32).toString('hex') });
    } catch (err) { res.status(500).json({ error: "Erro no servidor." }); }
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    const emailLower = email.toLowerCase().trim();
    try {
        const user = await pool.query("SELECT nome FROM usuarios WHERE email = $1", [emailLower]);
        if (user.rowCount === 0) return res.json({ message: "Se o e-mail estiver cadastrado, você receberá as instruções." });
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + (3 * 3600000)); 
        await pool.query("UPDATE usuarios SET reset_token = $1, reset_expiracao = $2 WHERE email = $3", [token, expiracao, emailLower]);
        const link = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
        await enviarEmail(emailLower, "Recuperação de Senha - Gateway SUS", `<p><a href="${link}">Redefinir Senha</a></p>`);
        res.json({ message: "E-mail de recuperação enviado!" });
    } catch (err) { res.status(500).json({ error: "Erro ao processar." }); }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, novaSenha } = req.body;
    try {
        const result = await pool.query("SELECT email FROM usuarios WHERE reset_token = $1 AND reset_expiracao > (CURRENT_TIMESTAMP - INTERVAL '3 hours')", [token]);
        if (result.rowCount === 0) return res.status(400).json({ error: "Token inválido ou expirado." });
        const salt = await bcrypt.genSalt(10);
        const senhaHash = await bcrypt.hash(novaSenha, salt);
        await pool.query("UPDATE usuarios SET senha = $1, reset_token = NULL, reset_expiracao = NULL WHERE email = $2", [senhaHash, result.rows[0].email]);
        res.json({ message: "Senha alterada com sucesso!" });
    } catch (err) { res.status(500).json({ error: "Erro interno." }); }
});

// --- LÓGICA FTP ---

const pastasFTP = { 
    'BPA': '/siasus/BPA', 
    'SIA': '/siasus/SIA', 
    'RAAS': '/siasus/RAAS', 
    'FPO': '/siasus/FPO' 
};

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    if (!pastasFTP[sistema]) return res.status(400).send("Sistema inválido.");
    const client = new ftp.Client(15000); 
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest", secure: false });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        res.json(list.filter(f => f.isFile).map(f => ({ name: f.name, size: (f.size / 1024 / 1024).toFixed(2) + " MB" })));
    } catch (e) { res.status(500).json({ error: "Erro FTP DATASUS." }); } finally { client.close(); }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const client = new ftp.Client(30000);
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema.toUpperCase()]);
        res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
        const tunnel = new PassThrough();
        tunnel.pipe(res);
        await client.downloadTo(tunnel, decodeURIComponent(arquivo));
    } catch (e) { if (!res.headersSent) res.status(500).send("Erro download."); } finally { client.close(); }
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

// --- INICIALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Gateway DATASUS Online na porta ${PORT}`);
});