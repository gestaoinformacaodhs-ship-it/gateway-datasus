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

        // Tabela: Mensagens do Suporte (Atualizada com sala_id)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS mensagens_suporte (
                id SERIAL PRIMARY KEY,
                sala_id TEXT, 
                usuario TEXT,
                texto TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("✔️ Banco de Dados pronto (Tabelas e Chat por Salas).");
    } catch (err) {
        console.error("❌ Erro ao inicializar/atualizar Tabelas:", err.message);
    }
}
initDB();

// --- LÓGICA DO CHAT (SOCKET.IO) COM SALAS PRIVADAS ---
io.on('connection', async (socket) => {
    console.log('🔌 Conexão estabelecida:', socket.id);

    // O cliente solicita entrar em uma sala (ID único, ex: e-mail do usuário)
    socket.on('entrar_na_sala', async (salaId) => {
        socket.join(salaId);
        console.log(`👤 Socket ${socket.id} entrou na sala: ${salaId}`);

        // Busca histórico específico desta sala
        try {
            const historico = await pool.query(
                "SELECT usuario, texto, timestamp FROM mensagens_suporte WHERE sala_id = $1 ORDER BY timestamp ASC LIMIT 100",
                [salaId]
            );
            socket.emit('historico_mensagens', historico.rows);
        } catch (err) {
            console.error("Erro ao carregar histórico da sala:", err.message);
        }
    });

    socket.on('enviar_mensagem', async (data) => {
        const { nome, mensagem, salaId } = data; 
        
        try {
            // Salva no banco vinculando à sala específica
            await pool.query(
                "INSERT INTO mensagens_suporte (sala_id, usuario, texto) VALUES ($1, $2, $3)",
                [salaId, nome, mensagem]
            );

            // Envia a mensagem apenas para quem está naquela sala (usuário + admin logado nela)
            io.to(salaId).emit('receber_mensagem', {
                usuario: nome,
                texto: mensagem,
                hora: new Date().toLocaleTimeString()
            });
        } catch (err) {
            console.error("Erro ao salvar mensagem:", err.message);
        }
    });

    socket.on('disconnect', () => {
        console.log('❌ Usuário desconectou.');
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

// --- ROTA DE RECUPERAÇÃO DE SENHA ADMIN ---
app.post('/api/recuperar-senha-admin', async (req, res) => {
    const { email } = req.body;
    const emailLower = email.toLowerCase().trim();
    const EMAIL_ADMIN_AUTORIZADO = "gestaoinformacaodhs@gmail.com"; 

    if (emailLower !== EMAIL_ADMIN_AUTORIZADO) {
        return res.json({ success: true, message: "Processamento concluído." });
    }

    const senhaMestra = "2024";
    const conteudoHtml = `
        <div style="font-family: sans-serif; background: #0f172a; color: white; padding: 40px; border-radius: 20px;">
            <h2 style="color: #3b82f6; text-align: center;">CONSOLE ADMIN</h2>
            <div style="background: #1e293b; padding: 30px; border-radius: 15px; border: 2px dashed #3b82f6; text-align: center;">
                <span style="font-size: 32px; font-weight: bold; color: #fff;">${senhaMestra}</span>
            </div>
        </div>
    `;

    try {
        await enviarEmail(emailLower, "🔒 Senha de Acesso Administrador", conteudoHtml);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- ROTAS DE USUÁRIO ---
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
        await enviarEmail(emailLower, "Ative sua conta - Gateway SUS", `<p><a href="${link}">Ativar Minha Conta</a></p>`);
        res.status(201).json({ message: "Verifique seu e-mail para ativar." });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: "E-mail já cadastrado." });
        res.status(500).json({ error: "Erro interno." });
    }
});

app.get('/api/activate', async (req, res) => {
    const { token } = req.query;
    try {
        const result = await pool.query(`UPDATE usuarios SET ativo = 1, token_ativacao = NULL WHERE token_ativacao = $1`, [token]);
        if (result.rowCount === 0) return res.status(400).send("Link inválido.");
        res.send("<h1>Conta Ativada!</h1><meta http-equiv='refresh' content='2;url=/index.html'>");
    } catch (err) { res.status(500).send("Erro."); }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();
    try {
        const result = await pool.query(`SELECT nome, email, senha, ativo FROM usuarios WHERE email = $1`, [emailLower]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(senha, user.senha))) return res.status(401).json({ error: "Credenciais inválidas." });
        if (user.ativo === 0) return res.status(403).json({ error: "Ative sua conta." });
        res.json({ user: user.nome, email: user.email });
    } catch (err) { res.status(500).json({ error: "Erro." }); }
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    const emailLower = email.toLowerCase().trim();
    try {
        const user = await pool.query("SELECT nome FROM usuarios WHERE email = $1", [emailLower]);
        if (user.rowCount === 0) return res.json({ message: "Instruções enviadas se o e-mail existir." });
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + (3 * 3600000)); 
        await pool.query("UPDATE usuarios SET reset_token = $1, reset_expiracao = $2 WHERE email = $3", [token, expiracao, emailLower]);
        const link = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
        await enviarEmail(emailLower, "Recuperação de Senha", `<p><a href="${link}">Redefinir Senha</a></p>`);
        res.json({ message: "E-mail enviado!" });
    } catch (err) { res.status(500).json({ error: "Erro." }); }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, novaSenha } = req.body;
    try {
        const result = await pool.query("SELECT email FROM usuarios WHERE reset_token = $1 AND reset_expiracao > (CURRENT_TIMESTAMP - INTERVAL '3 hours')", [token]);
        if (result.rowCount === 0) return res.status(400).json({ error: "Expirado." });
        const salt = await bcrypt.genSalt(10);
        const senhaHash = await bcrypt.hash(novaSenha, salt);
        await pool.query("UPDATE usuarios SET senha = $1, reset_token = NULL, reset_expiracao = NULL WHERE email = $2", [senhaHash, result.rows[0].email]);
        res.json({ message: "Sucesso!" });
    } catch (err) { res.status(500).json({ error: "Erro." }); }
});

// --- LÓGICA FTP ---
const pastasFTP = { 'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 'FPO': '/siasus/FPO' };

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    const client = new ftp.Client(15000); 
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        res.json(list.filter(f => f.isFile).map(f => ({ name: f.name, size: (f.size / 1024 / 1024).toFixed(2) + " MB" })));
    } catch (e) { res.status(500).json({ error: "Erro FTP." }); } finally { client.close(); }
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
    } catch (e) { if (!res.headersSent) res.status(500).send("Erro."); } finally { client.close(); }
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
        res.json({ message: "Sucesso!" });
    } catch (err) { res.status(500).json({ error: "Erro." }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Gateway DATASUS Online na porta ${PORT}`);
});