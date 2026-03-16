const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const { Pool } = require('pg'); 
const { PassThrough } = require('stream');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const Brevo = require('@getbrevo/brevo');
const compression = require('compression');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app); 

// --- ATIVAÇÃO DA COMPRESSÃO ---
app.use(compression()); 

// --- CONFIGURAÇÃO SOCKET.IO ---
const io = new Server(server, {
    cors: {
        origin: ["https://gateway-datasus.onrender.com", "http://localhost:3000"],
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
}); 

// Configurações Express
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
app.use(express.static('public'));

// --- CONFIGURAÇÃO BREVO API ---
let apiInstance = new Brevo.TransactionalEmailsApi();
if (process.env.BREVO_API_KEY) {
    apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
    console.log("✔️ API Brevo configurada com sucesso.");
}

// --- CONFIGURAÇÃO BANCO DE DADOS (POSTGRES) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 10 
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome TEXT,
                email TEXT UNIQUE,
                senha TEXT,
                ativo INTEGER DEFAULT 1, 
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
        } catch (err) { console.error("Erro histórico chat:", err.message); }
    });

    socket.on('enviar_mensagem', async (data) => {
        const { nome, mensagem, salaId } = data; 
        if (!salaId || !mensagem) return;
        try {
            await pool.query("INSERT INTO mensagens_suporte (sala_id, usuario, texto) VALUES ($1, $2, $3)", [salaId, nome, mensagem]);
            const msgData = { 
                usuario: nome, 
                texto: mensagem, 
                salaId, 
                hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) 
            };
            io.to(salaId).emit('receber_mensagem', msgData);
            if (nome !== "Suporte Arpoador") io.to('admin_room').emit('receber_mensagem', msgData);
        } catch (err) { console.error("Erro ao enviar mensagem:", err.message); }
    });
});

// --- FUNÇÃO AUXILIAR E-MAIL (MELHORADA) ---
async function enviarEmail(emailDestino, assunto, html) {
    try {
        if (!process.env.BREVO_API_KEY) {
            console.warn("⚠️ BREVO_API_KEY não encontrada. E-mail não enviado.");
            return;
        }
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = assunto;
        sendSmtpEmail.htmlContent = html; // Usando htmlContent para renderizar visualmente
        sendSmtpEmail.sender = { name: "Gateway SUS", email: "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ email: emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`📧 E-mail enviado para: ${emailDestino}`);
    } catch (e) { console.error("❌ Erro e-mail:", e.message); }
}

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/register', async (req, res) => {
    const { nome, email, senha } = req.body;
    try {
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(senha, salt);
        await pool.query(
            "INSERT INTO usuarios (nome, email, senha, ativo) VALUES ($1, $2, $3, 1)",
            [nome, email.toLowerCase().trim(), hash]
        );
        res.json({ message: "Conta criada com sucesso! Faça login para acessar." });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: "E-mail já cadastrado." });
        res.status(500).json({ error: "Erro ao criar conta." });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    try {
        const result = await pool.query(`SELECT nome, email, senha, ativo FROM usuarios WHERE email = $1`, [email.toLowerCase().trim()]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(senha, user.senha))) return res.status(401).json({ error: "Credenciais inválidas." });
        if (user.ativo === 0) return res.status(403).json({ error: "Sua conta aguarda ativação." });
        res.json({ user: user.nome, email: user.email });
    } catch (err) { res.status(500).json({ error: "Erro no servidor." }); }
});

app.post('/api/update-profile', async (req, res) => {
    const { email, nome, novaSenha } = req.body;
    try {
        if (!email) return res.status(400).json({ error: "E-mail não identificado." });

        if (novaSenha && novaSenha.trim() !== "") {
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash(novaSenha, salt);
            await pool.query(
                "UPDATE usuarios SET nome = $1, senha = $2 WHERE email = $3", 
                [nome, hash, email.toLowerCase().trim()]
            );
        } else {
            await pool.query(
                "UPDATE usuarios SET nome = $1 WHERE email = $2", 
                [nome, email.toLowerCase().trim()]
            );
        }
        res.json({ message: "Perfil atualizado com sucesso!", novoNome: nome });
    } catch (err) { 
        console.error("❌ Erro ao atualizar perfil:", err);
        res.status(500).json({ error: "Erro ao atualizar dados no banco." }); 
    }
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000); // 1 hora de validade
        const result = await pool.query(
            "UPDATE usuarios SET reset_token = $1, reset_expiracao = $2 WHERE email = $3 RETURNING nome",
            [token, expiracao, email.toLowerCase().trim()]
        );
        
        if (result.rowCount > 0) {
            const userName = result.rows[0].nome;
            const link = `https://gateway-datasus.onrender.com/reset-password.html?token=${token}`;
            
            // E-MAIL FORMATADO COM BOTÃO E LOGO
            const htmlEmail = `
                <div style="font-family: Arial, sans-serif; text-align: center; color: #333; padding: 20px;">
                    <h1 style="color: #007bff;">Gateway SUS</h1>
                    <p>Olá <strong>${userName}</strong>,</p>
                    <p>Você solicitou a redefinição de sua senha. Clique no botão abaixo para prosseguir:</p>
                    <div style="margin: 30px 0;">
                        <a href="${link}" style="background-color: #007bff; color: white; padding: 15px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
                            REDEFINIR MINHA SENHA
                        </a>
                    </div>
                    <p style="font-size: 12px; color: #777;">Este link é válido por 1 hora. Se você não solicitou isso, ignore este e-mail.</p>
                </div>
            `;

            await enviarEmail(email, "Recuperação de Senha - Gateway SUS", htmlEmail);
        }
        res.json({ message: "Se o e-mail existir, as instruções foram enviadas." });
    } catch (err) { 
        console.error("Erro no forgot-password:", err);
        res.status(500).json({ error: "Erro ao processar recuperação." }); 
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, novaSenha } = req.body;
    try {
        if (!token || !novaSenha) return res.status(400).json({ error: "Dados incompletos." });

        // Verificação robusta do token e data
        const result = await pool.query(
            "SELECT id FROM usuarios WHERE reset_token = $1 AND reset_expiracao > NOW()", 
            [token]
        );
        
        if (result.rows.length === 0) {
            return res.status(400).json({ error: "Token inválido ou expirado. Tente novamente." });
        }
        
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(novaSenha, salt);
        
        await pool.query(
            "UPDATE usuarios SET senha = $1, reset_token = NULL, reset_expiracao = NULL WHERE id = $2", 
            [hash, result.rows[0].id]
        );
        res.json({ message: "Senha atualizada com sucesso!" });
    } catch (err) { 
        console.error("Erro técnico ao redefinir senha:", err);
        res.status(500).json({ error: "Erro interno ao salvar nova senha." }); 
    }
});

// --- LÓGICA FTP DATASUS ---
const pastasFTP = { 
    'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 
    'FPO': '/siasus/FPO', 'CNES': '/cnes',
    'SIHD': '/public/sistemas/dsweb/SIHD/Programas',
    'CIHA': '/public/sistemas/dsweb/CIHA'
};

const cacheFTP = {}; 

function getFtpHost(sistema) {
    if (sistema === 'CNES') return "ftp.datasus.gov.br";
    if (sistema === 'SIHD' || sistema === 'CIHA') return "ftp2.datasus.gov.br";
    return "arpoador.datasus.gov.br";
}

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    if (!pastasFTP[sistema]) return res.status(400).json({ error: "Sistema inválido." });

    const agora = Date.now();
    if (cacheFTP[sistema] && (agora - cacheFTP[sistema].time < 300000)) {
        return res.json(cacheFTP[sistema].data);
    }
    
    const client = new ftp.Client(15000); 
    try {
        await client.access({ host: getFtpHost(sistema), user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        const data = list
            .filter(f => f.isFile)
            .map(f => ({ 
                name: f.name, 
                size: (f.size / 1024 / 1024).toFixed(2) + " MB",
                rawDate: f.modifiedAt 
            }))
            .sort((a, b) => new Date(b.rawDate) - new Date(a.rawDate)); 
        
        cacheFTP[sistema] = { time: agora, data: data }; 
        res.json(data);
    } catch (e) { 
        res.status(500).json({ error: "FTP DATASUS instável no momento." }); 
    } finally { client.close(); }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const sisUpper = sistema.toUpperCase();
    const client = new ftp.Client(0); 
    try {
        await client.access({ host: getFtpHost(sisUpper), user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sisUpper]);
        res.setHeader('Content-Disposition', `attachment; filename="${decodeURIComponent(arquivo)}"`);
        const tunnel = new PassThrough();
        tunnel.pipe(res);
        await client.downloadTo(tunnel, decodeURIComponent(arquivo));
    } catch (e) { if (!res.headersSent) res.status(500).send("Erro no download."); } 
    finally { client.close(); }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Gateway DATASUS rodando na porta ${PORT}`);
});