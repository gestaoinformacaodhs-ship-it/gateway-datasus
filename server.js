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

// --- AJUSTE NO SOCKET.IO PARA PRODUÇÃO (RENDER) ---
const io = new Server(server, {
    cors: {
        origin: ["https://gateway-datasus.onrender.com", "http://localhost:3000"],
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
}); 

// Aumentar o limite do JSON para suportar o envio de imagens em Base64
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
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

        await pool.query(`
            CREATE TABLE IF NOT EXISTS mensagens_suporte (
                id SERIAL PRIMARY KEY,
                sala_id TEXT, 
                usuario TEXT,
                texto TEXT,
                arquivo TEXT, 
                tipo_arquivo TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Garantir que as colunas de arquivo existam para suporte a imagens
        try {
            await pool.query("ALTER TABLE mensagens_suporte ADD COLUMN IF NOT EXISTS arquivo TEXT;");
            await pool.query("ALTER TABLE mensagens_suporte ADD COLUMN IF NOT EXISTS tipo_arquivo TEXT;");
        } catch (e) { /* colunas já existem */ }

        console.log("✔️ Banco de Dados pronto (Suporte a Imagens e Arquivos).");
    } catch (err) {
        console.error("❌ Erro no Banco de Dados:", err.message);
    }
}
initDB();

// --- LÓGICA DO CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
    console.log('🔌 Conexão estabelecida:', socket.id);

    socket.on('admin_entrar', () => {
        socket.join('admin_room');
        console.log(`🛠️ Admin ${socket.id} entrou na sala de monitoramento.`);
    });

    socket.on('entrar_na_sala', async (salaId) => {
        if (!salaId) return;
        socket.join(salaId);
        
        try {
            const historico = await pool.query(
                "SELECT usuario, texto, arquivo, tipo_arquivo as tipo, timestamp FROM mensagens_suporte WHERE sala_id = $1 ORDER BY timestamp ASC LIMIT 100",
                [salaId]
            );
            socket.emit('historico_mensagens', historico.rows);
        } catch (err) {
            console.error("Erro ao carregar histórico:", err.message);
        }
    });

    socket.on('enviar_mensagem', async (data) => {
        const { nome, mensagem, salaId } = data; 
        if (!salaId || !mensagem) return;
        
        try {
            await pool.query(
                "INSERT INTO mensagens_suporte (sala_id, usuario, texto) VALUES ($1, $2, $3)",
                [salaId, nome, mensagem]
            );

            const msgData = {
                usuario: nome,
                texto: mensagem,
                salaId: salaId, 
                hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
            };

            io.to(salaId).emit('receber_mensagem', msgData);
            if (nome !== "Suporte Arpoador") {
                io.to('admin_room').emit('receber_mensagem', msgData);
            }
        } catch (err) {
            console.error("Erro ao salvar mensagem:", err.message);
        }
    });

    // --- NOVA LÓGICA: RECEBER E ENVIAR ARQUIVOS ---
    socket.on('enviar_arquivo', async (data) => {
        const { nome, arquivo, tipo, nomeArquivo, salaId } = data;
        if (!salaId || !arquivo) return;

        try {
            // Salva no banco (Opcional: em produção, o ideal é salvar em um Storage e guardar apenas a URL)
            await pool.query(
                "INSERT INTO mensagens_suporte (sala_id, usuario, texto, arquivo, tipo_arquivo) VALUES ($1, $2, $3, $4, $5)",
                [salaId, nome, `Arquivo: ${nomeArquivo}`, arquivo, tipo]
            );

            const msgData = {
                usuario: nome,
                texto: `Enviou um arquivo: ${nomeArquivo}`,
                arquivo: arquivo,
                tipo: tipo,
                salaId: salaId,
                hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
            };

            io.to(salaId).emit('receber_mensagem', msgData);
            if (nome !== "Suporte Arpoador") {
                io.to('admin_room').emit('receber_mensagem', msgData);
            }
        } catch (err) {
            console.error("Erro ao processar arquivo:", err.message);
        }
    });

    socket.on('encerrar_conversa', (salaId) => {
        io.to(salaId).emit('conversa_encerrada', { salaId });
        console.log(`🔒 Conversa ${salaId} encerrada.`);
    });

    socket.on('disconnect', () => {
        console.log('❌ Usuário desconectou.');
    });
});

// --- FUNÇÃO AUXILIAR DE E-MAIL (BREVO) ---
async function enviarEmail(emailDestino, assunto, html) {
    try {
        if (!process.env.BREVO_API_KEY) return;
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = assunto;
        sendSmtpEmail.htmlContent = html;
        sendSmtpEmail.sender = { name: "Gateway SUS", email: "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ email: emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
    } catch (e) { 
        console.error("Erro e-mail:", e.message); 
    }
}

// --- ROTAS DE API ---

app.post('/api/recuperar-senha-admin', async (req, res) => {
    const { email } = req.body;
    const emailLower = email?.toLowerCase().trim();
    if (emailLower !== "gestaoinformacaodhs@gmail.com") return res.json({ success: true });

    const senhaMestra = "2024";
    const conteudoHtml = `
        <div style="font-family: sans-serif; background: #0f172a; color: white; padding: 40px; border-radius: 20px;">
            <h2 style="color: #3b82f6; text-align: center;">CONSOLE ADMIN</h2>
            <div style="background: #1e293b; padding: 30px; border-radius: 15px; border: 2px dashed #3b82f6; text-align: center;">
                <span style="font-size: 32px; font-weight: bold; color: #fff;">${senhaMestra}</span>
            </div>
        </div>`;

    try {
        await enviarEmail(emailLower, "🔒 Senha de Acesso Administrador", conteudoHtml);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/register', async (req, res) => {
    const { nome, email, senha } = req.body;
    const emailLower = email.toLowerCase().trim();
    const token = crypto.randomBytes(20).toString('hex');

    try {
        const senhaHash = await bcrypt.hash(senha, 10);
        await pool.query(
            `INSERT INTO usuarios (nome, email, senha, token_ativacao) VALUES ($1, $2, $3, $4)`,
            [nome, emailLower, senhaHash, token]
        );
        const link = `${req.protocol}://${req.get('host')}/api/activate?token=${token}`;
        await enviarEmail(emailLower, "Ative sua conta - Gateway SUS", `<p><a href="${link}">Ativar Minha Conta</a></p>`);
        res.status(201).json({ message: "Verifique seu e-mail para ativar." });
    } catch (err) {
        res.status(400).json({ error: "E-mail já cadastrado ou erro interno." });
    }
});

app.get('/api/activate', async (req, res) => {
    try {
        const result = await pool.query(`UPDATE usuarios SET ativo = 1, token_ativacao = NULL WHERE token_ativacao = $1`, [req.query.token]);
        if (result.rowCount === 0) return res.status(400).send("Link inválido.");
        res.send("<h1>Conta Ativada!</h1><meta http-equiv='refresh' content='2;url=/index.html'>");
    } catch (err) { res.status(500).send("Erro na ativação."); }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    try {
        const result = await pool.query(`SELECT nome, email, senha, ativo FROM usuarios WHERE email = $1`, [email.toLowerCase().trim()]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(senha, user.senha))) return res.status(401).json({ error: "Credenciais inválidas." });
        if (user.ativo === 0) return res.status(403).json({ error: "Ative sua conta no e-mail." });
        res.json({ user: user.nome, email: user.email });
    } catch (err) { res.status(500).json({ error: "Erro no login." }); }
});

app.post('/api/forgot-password', async (req, res) => {
    const emailLower = req.body.email?.toLowerCase().trim();
    try {
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000); 
        const result = await pool.query("UPDATE usuarios SET reset_token = $1, reset_expiracao = $2 WHERE email = $3", [token, expiracao, emailLower]);
        if (result.rowCount > 0) {
            const link = `${req.protocol}://${req.get('host')}/reset-password.html?token=${token}`;
            await enviarEmail(emailLower, "Recuperação de Senha", `<p><a href="${link}">Redefinir Senha</a></p>`);
        }
        res.json({ message: "Instruções enviadas para o seu e-mail." });
    } catch (err) { res.status(500).json({ error: "Erro ao processar." }); }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, novaSenha } = req.body;
    try {
        const senhaHash = await bcrypt.hash(novaSenha, 10);
        const result = await pool.query("UPDATE usuarios SET senha = $1, reset_token = NULL, reset_expiracao = NULL WHERE reset_token = $2 AND reset_expiracao > CURRENT_TIMESTAMP", [senhaHash, token]);
        if (result.rowCount === 0) return res.status(400).json({ error: "Token inválido ou expirado." });
        res.json({ message: "Senha redefinida com sucesso!" });
    } catch (err) { res.status(500).json({ error: "Erro ao redefinir." }); }
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
    } catch (e) { res.status(500).json({ error: "Erro ao listar arquivos FTP." }); } finally { client.close(); }
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
    } catch (e) { if (!res.headersSent) res.status(500).send("Erro no download."); } finally { client.close(); }
});

app.put('/api/update-profile', async (req, res) => {
    const { nome, email, senha } = req.body;
    try {
        if (senha) {
            const senhaHash = await bcrypt.hash(senha, 10);
            await pool.query(`UPDATE usuarios SET nome = $1, senha = $2 WHERE email = $3`, [nome, senhaHash, email]);
        } else {
            await pool.query(`UPDATE usuarios SET nome = $1 WHERE email = $2`, [nome, email]);
        }
        res.json({ message: "Perfil atualizado com sucesso!" });
    } catch (err) { res.status(500).json({ error: "Erro ao atualizar perfil." }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Gateway DATASUS Online na porta ${PORT}`);
});