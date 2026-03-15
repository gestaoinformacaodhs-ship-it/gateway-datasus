const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const { Pool } = require('pg'); 
const { PassThrough } = require('stream');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Brevo = require('@getbrevo/brevo');
const compression = require('compression'); // NOVO: Para compressão de dados

// --- IMPORTS PARA O CHAT ---
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app); 

// --- ATIVAÇÃO DA COMPRESSÃO ---
app.use(compression()); 

// --- AJUSTE NO SOCKET.IO PARA PRODUÇÃO (RENDER) ---
const io = new Server(server, {
    cors: {
        origin: ["https://gateway-datasus.onrender.com", "http://localhost:3000"],
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
}); 

// Limites de JSON
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(express.static('public'));

// --- CONFIGURAÇÃO BREVO API ---
let apiInstance = new Brevo.TransactionalEmailsApi();
if (process.env.BREVO_API_KEY) {
    apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
    console.log("✔️ API Brevo configurada com sucesso.");
}

// --- CONFIGURAÇÃO SUPABASE/POSTGRES (OTIMIZADA) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, // Fecha conexões inativas após 30s
    max: 10 // Limita o número de conexões para não estourar o banco
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
        console.log("✔️ Banco de Dados pronto.");
    } catch (err) {
        console.error("❌ Erro no Banco de Dados:", err.message);
    }
}
initDB();

// --- LÓGICA DO CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
    socket.on('admin_entrar', () => socket.join('admin_room'));

    socket.on('entrar_na_sala', async (salaId) => {
        if (!salaId) return;
        socket.join(salaId);
        try {
            const historico = await pool.query(
                "SELECT usuario, texto, arquivo, tipo_arquivo as tipo, timestamp FROM mensagens_suporte WHERE sala_id = $1 ORDER BY timestamp ASC LIMIT 100",
                [salaId]
            );
            socket.emit('historico_mensagens', historico.rows);
        } catch (err) { console.error("Erro histórico:", err.message); }
    });

    socket.on('enviar_mensagem', async (data) => {
        const { nome, mensagem, salaId } = data; 
        if (!salaId || !mensagem) return;
        try {
            await pool.query("INSERT INTO mensagens_suporte (sala_id, usuario, texto) VALUES ($1, $2, $3)", [salaId, nome, mensagem]);
            const msgData = { 
                usuario: nome, texto: mensagem, salaId, 
                hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) 
            };
            io.to(salaId).emit('receber_mensagem', msgData);
            if (nome !== "Suporte Arpoador") io.to('admin_room').emit('receber_mensagem', msgData);
        } catch (err) { console.error("Erro mensagem:", err.message); }
    });

    socket.on('enviar_arquivo', async (data) => {
        const { nome, arquivo, tipo, nomeArquivo, salaId } = data;
        if (!salaId || !arquivo) return;
        try {
            await pool.query("INSERT INTO mensagens_suporte (sala_id, usuario, texto, arquivo, tipo_arquivo) VALUES ($1, $2, $3, $4, $5)", [salaId, nome, `Arquivo: ${nomeArquivo}`, arquivo, tipo]);
            const msgData = { 
                usuario: nome, texto: `Enviou: ${nomeArquivo}`, arquivo, tipo, salaId, 
                hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) 
            };
            io.to(salaId).emit('receber_mensagem', msgData);
            if (nome !== "Suporte Arpoador") io.to('admin_room').emit('receber_mensagem', msgData);
        } catch (err) { console.error("Erro arquivo:", err.message); }
    });

    socket.on('encerrar_conversa', async (salaId) => {
        try {
            await pool.query("DELETE FROM mensagens_suporte WHERE sala_id = $1", [salaId]);
            io.to(salaId).emit('limpar_tela_chat'); 
        } catch (err) { console.error("Erro limpar:", err.message); }
    });
});

// --- FUNÇÃO E-MAIL ---
async function enviarEmail(emailDestino, assunto, html) {
    try {
        if (!process.env.BREVO_API_KEY) return;
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = assunto;
        sendSmtpEmail.htmlContent = html;
        sendSmtpEmail.sender = { name: "Gateway SUS", email: "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ email: emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
    } catch (e) { console.error("Erro e-mail:", e.message); }
}

// --- ROTAS DE AUTENTICAÇÃO ---
app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    try {
        const result = await pool.query(`SELECT nome, email, senha, ativo FROM usuarios WHERE email = $1`, [email.toLowerCase().trim()]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(senha, user.senha))) return res.status(401).json({ error: "Credenciais inválidas." });
        if (user.ativo === 0) return res.status(403).json({ error: "Ative sua conta." });
        res.json({ user: user.nome, email: user.email });
    } catch (err) { res.status(500).json({ error: "Erro no servidor." }); }
});

// --- LÓGICA FTP COM CACHE (LIMPO E RÁPIDO) ---
const pastasFTP = { 
    'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 
    'FPO': '/siasus/FPO', 'CNES': '/cnes',
    'SIHD': '/public/sistemas/dsweb/SIHD/Programas',
    'CIHA': '/public/sistemas/dsweb/CIHA'
};

const cacheFTP = {}; // Armazena listagens temporariamente

function getFtpHost(sistema) {
    if (sistema === 'CNES') return "ftp.datasus.gov.br";
    if (sistema === 'SIHD' || sistema === 'CIHA') return "ftp2.datasus.gov.br";
    return "arpoador.datasus.gov.br";
}

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    if (!pastasFTP[sistema]) return res.status(400).json({ error: "Inválido." });

    // Se houver cache de menos de 5 minutos, retorna ele
    const agora = Date.now();
    if (cacheFTP[sistema] && (agora - cacheFTP[sistema].time < 300000)) {
        return res.json(cacheFTP[sistema].data);
    }
    
    const client = new ftp.Client(15000); // Timeout de 15s para não travar o server
    try {
        await client.access({ host: getFtpHost(sistema), user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        const data = list.filter(f => f.isFile).map(f => ({ 
            name: f.name, 
            size: (f.size / 1024 / 1024).toFixed(2) + " MB" 
        })).reverse();
        
        cacheFTP[sistema] = { time: agora, data: data }; // Salva no cache
        res.json(data);
    } catch (e) { 
        res.status(500).json({ error: "FTP DATASUS instável." }); 
    } finally { client.close(); }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const sisUpper = sistema.toUpperCase();
    if (!pastasFTP[sisUpper]) return res.status(400).send("Sistema inválido.");

    const client = new ftp.Client(0); // Timeout 0 para downloads longos
    try {
        await client.access({ host: getFtpHost(sisUpper), user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sisUpper]);
        
        res.setHeader('Content-Disposition', `attachment; filename="${decodeURIComponent(arquivo)}"`);
        const tunnel = new PassThrough();
        tunnel.pipe(res);
        await client.downloadTo(tunnel, decodeURIComponent(arquivo));
    } catch (e) { if (!res.headersSent) res.status(500).send("Erro download."); } 
    finally { client.close(); }
});

// --- FINALIZAÇÃO ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Gateway DATASUS Online na porta ${PORT}`);
});