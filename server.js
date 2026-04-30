require('dotenv').config();
const express = require('express');

const ftp = require("basic-ftp");
const path = require('path');
const { Pool } = require('pg'); 
const { PassThrough } = require('stream');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Brevo = require('@getbrevo/brevo');
const compression = require('compression');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const emailValidator = require('email-validator');
const winston = require('winston');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'gateway-datasus' },
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecretKey ? require('stripe')(stripeSecretKey) : null;

const app = express();
app.set('trust proxy', 1); // Confia no proxy do Render para o express-rate-limit
const server = http.createServer(app); 

// --- CONFIGURAÇÃO IA (GEMINI) ---
// Removida biblioteca oficial em favor de REST puro para máxima estabilidade v1

// --- COMPRESSÃO E PARSER ---
app.use(compression()); 
app.use(express.json({ limit: '25mb' })); 
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static('public'));

// --- RATE LIMITING ---
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // limit each IP to 5 requests per windowMs
    message: 'Too many authentication attempts, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

const downloadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 downloads per hour
    message: 'Too many downloads, please try again later.',
});

// --- CONFIGURAÇÃO SOCKET.IO ---
const io = new Server(server, {
    cors: {
        origin: ["https://gateway-datasus.onrender.com", "http://localhost:3000"],
        methods: ["GET", "POST"],
        credentials: true
    },
    maxHttpBufferSize: 1e7, // 10MB
    transports: ['websocket', 'polling']
}); 

// --- CONFIGURAÇÃO BREVO API ---
let apiInstance = new Brevo.TransactionalEmailsApi();
if (process.env.BREVO_API_KEY) {
    apiInstance.setApiKey(Brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);
    logger.info("✔️ API Brevo configurada com sucesso.");
}

// --- CONFIGURAÇÃO BANCO DE DADOS (PostgreSQL) ---
const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 15,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
}) : null;

if (pool) {
    pool.on('error', (err) => {
        console.error('❌ Erro inesperado no cliente PostgreSQL:', err.message);
    });
}

async function initDB() {
    if (!pool) {
        console.warn("⚠️ DATABASE_URL não definida. Pulando inicialização do banco.");
        return;
    }
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                senha TEXT NOT NULL,
                ativo INTEGER DEFAULT 1, 
                role TEXT DEFAULT 'user',
                reset_token TEXT,
                reset_expiracao TIMESTAMP
            );
        `);
        // Migração simples para adicionar a coluna 'role' caso não exista
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='role') THEN
                    ALTER TABLE usuarios ADD COLUMN role TEXT DEFAULT 'user';
                END IF;
            END $$;
        `);

        // Migração simples para adicionar a coluna 'balance' caso não exista
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='balance') THEN
                    ALTER TABLE usuarios ADD COLUMN balance NUMERIC(12,2) DEFAULT 0;
                END IF;
            END $$;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS mensagens_suporte (
                id SERIAL PRIMARY KEY,
                sala_id TEXT NOT NULL, 
                usuario TEXT NOT NULL,
                texto TEXT,
                arquivo TEXT, 
                tipo_arquivo TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS transacoes (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
                tipo TEXT NOT NULL,
                valor NUMERIC(12,2) NOT NULL,
                status TEXT NOT NULL DEFAULT 'completed',
                descricao TEXT,
                referencia TEXT,
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // --- GARANTIR USUÁRIO ADMIN ---
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash('admin', salt);
        await pool.query(`
            INSERT INTO usuarios (nome, email, senha, ativo) 
            VALUES ('Administrador', 'admin', $1, 1) 
            ON CONFLICT (email) DO NOTHING;
        `, [hash]);

        client.release();
        console.log("✔️ Banco de Dados pronto e Usuário Admin verificado.");
    } catch (err) {
        console.error("❌ Erro Crítico no Banco de Dados:");
        console.error("Mensagem:", err.message);
        console.error("Dica: Verifique se o projeto no Supabase não está PAUSADO.");
    }
}
initDB();

// --- CONTROLE DE SESSÕES ATIVAS ---
const activeSessions = {}; // salaId -> { socketId, nomeAtendente }
const geminiCache = new Map(); // Cache simples para respostas IA

// --- FUNÇÃO IA INTELIGENTE (GEMINI) ---
// --- FUNÇÃO IA INTELIGENTE (GEMINI REST v1) ---
async function processarIA(salaId, mensagemUsuario) {
    console.log(`🤖 [IA] Verificando processamento direto (v1) para: ${salaId}`);
    
    const key = process.env.GOOGLE_API_KEY ? process.env.GOOGLE_API_KEY.replace(/['"\s]/g, '') : null;
    if (activeSessions[salaId]) return;

    // --- BOT DE REGRAS (SEM IA) ---
    const msgLower = mensagemUsuario.toLowerCase();
    let respostaAutomatica = null;

    const regras = [
        { keywords: ['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite'], resposta: "Olá! Eu sou o assistente do Gateway DATASUS. Como posso ajudar você hoje?" },
        { keywords: ['download', 'baixar', 'arquivos', 'arquivo'], resposta: "Para baixar arquivos, acesse o painel desejado (SIA, SIHD ou CNES) no Dashboard, escolha o estado e a competência, e clique no ícone de download." },
        { keywords: ['sia', 'siasus', 'bpa'], resposta: "O módulo SIA permite baixar arquivos de produção ambulatorial. Você pode filtrar por tipo (PA, PS, etc.) no repositório." },
        { keywords: ['sih', 'sihd'], resposta: "O módulo SIHD gerencia arquivos de internação hospitalar (RD). Eles estão disponíveis na seção Painel SIHD." },
        { keywords: ['cnes'], resposta: "Os arquivos do CNES (Cadastro Nacional de Estabelecimentos de Saúde) são atualizados mensalmente e podem ser encontrados no botão CNES do Dashboard." },
        { keywords: ['ajuda', 'suporte', 'atendente', 'humano'], resposta: "Entendi. Vou notificar um atendente humano para assumir este chamado. Por favor, aguarde um momento." },
        { keywords: ['senha', 'login', 'acesso'], resposta: "Se você esqueceu sua senha, use a opção 'Esqueci minha senha' na tela de login. Para novas contas, solicite em 'Solicite uma conta'." }
    ];

    for (const regra of regras) {
        if (regra.keywords.some(k => msgLower.includes(k))) {
            respostaAutomatica = regra.resposta;
            break;
        }
    }

    if (respostaAutomatica) {
        console.log(`🤖 [BOT] Resposta por regra encontrada.`);
        const msgBot = {
            usuario: "Assistente Virtual",
            texto: respostaAutomatica,
            salaId: salaId,
            timestamp: new Date(),
            isAI: true
        };
        await pool.query("INSERT INTO mensagens_suporte (sala_id, usuario, texto) VALUES ($1, $2, $3)", [salaId, "Assistente Virtual", respostaAutomatica]);
        io.to(salaId).emit('receber_mensagem', msgBot);
        return;
    }

    // Se não houver regra e não houver chave de IA, ou se o usuário preferir não usar IA
    if (!key) {
        return; 
    }

    try {
        // Usar a versão 'v1' da API que é mais estável para alguns modelos/chaves
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }, { apiVersion: "v1" });
        
        const prompt = `
            Você é o assistente virtual inteligente do "Gateway DATASUS".
            Seu objetivo é ajudar usuários com dúvidas sobre o sistema e downloads de arquivos (BPA, SIA, CNES, SIHD, etc.).
            Mantenha suas respostas curtas (máximo 3 frases), profissionais e úteis em português. 
            Se não souber a resposta, peça para o usuário aguardar um suporte humano.
            O usuário perguntou: "${mensagemUsuario}"
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const resposta = response.text();
        
        if (!resposta) throw new Error("Resposta da IA veio vazia.");

        // Cache a resposta
        geminiCache.set(cacheKey, resposta);
        if (geminiCache.size > 100) {
            const firstKey = geminiCache.keys().next().value;
            geminiCache.delete(firstKey);
        }

        const msgAI = {
            usuario: "IA Inteligente",
            texto: resposta,
            salaId: salaId,
            timestamp: new Date(),
            isAI: true
        };

        // Salva no banco
        await pool.query(
            "INSERT INTO mensagens_suporte (sala_id, usuario, texto) VALUES ($1, $2, $3)",
            [salaId, "IA Inteligente", resposta]
        );

        io.to(salaId).emit('receber_mensagem', msgAI);

    } catch (err) {
        console.error("❌ [IA] Erro crítico com SDK:", err.message);
        io.to(salaId).emit('receber_mensagem', { 
            usuario: "Sistema", 
            texto: `⚠️ Falha técnica na IA: ${err.message}. Um suporte humano será necessário.` 
        });
    }
}


// --- LÓGICA DO CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
    
    socket.on('admin_entrar', async (data) => {
        socket.join('admin_room');
        socket.nomeAtendente = data ? data.nome : "Suporte";
        console.log(`🛠️ Admin ${socket.nomeAtendente} entrou no monitoramento.`);
        
        // Envia lista de sessões ocupadas para o novo admin
        const ocupados = {};
        for (const [salaId, session] of Object.entries(activeSessions)) {
            ocupados[salaId] = session.nomeAtendente;
        }
        socket.emit('lista_usuarios_ocupados', ocupados);

        // --- RECUPERAÇÃO DE FILA: Carrega chamados pendentes do Banco ---
        try {
            const fila = await pool.query(
                "SELECT DISTINCT ON (sala_id) sala_id, usuario FROM mensagens_suporte WHERE usuario != 'IA Inteligente' AND usuario NOT LIKE 'Suporte%' ORDER BY sala_id, timestamp DESC LIMIT 50"
            );
            socket.emit('fila_ativa', fila.rows.map(r => ({ nome: r.usuario, salaId: r.sala_id })));
        } catch (err) { console.error("Erro ao carregar fila ativa:", err.message); }
    });
    
    socket.on('entrar_na_sala', async (salaId) => {
        if (!salaId) return;
        
        // Se for um suporte tentando entrar numa sala já ocupada
        if (socket.rooms.has('admin_room') && activeSessions[salaId] && activeSessions[salaId].socketId !== socket.id) {
            socket.emit('erro_chat', { mensagem: `Este usuário já está sendo atendido por ${activeSessions[salaId].nomeAtendente}.` });
            return;
        }

        // Se for suporte, marca como atendendo
        if (socket.rooms.has('admin_room')) {
            const nomeAtendente = socket.nomeAtendente || "Suporte";
            activeSessions[salaId] = { socketId: socket.id, nomeAtendente: nomeAtendente };
            io.to('admin_room').emit('usuario_ocupado', { salaId, atendente: socket.id, nomeAtendente: nomeAtendente });
        }

        const salasAtuais = Array.from(socket.rooms);
        salasAtuais.forEach(sala => {
            if (sala !== socket.id && sala !== 'admin_room') {
                socket.leave(sala);
                // Se sair de uma sala, remove do activeSessions se for o atendente
                if (activeSessions[sala] && activeSessions[sala].socketId === socket.id) delete activeSessions[sala];
            }
        });

        socket.join(salaId);
        
        try {
            const historico = await pool.query(
                "SELECT usuario, texto, arquivo, tipo_arquivo as tipo, timestamp FROM mensagens_suporte WHERE sala_id = $1 ORDER BY timestamp ASC LIMIT 100",
                [salaId]
            );
            socket.emit('historico_mensagens', historico.rows);
        } catch (err) { 
            console.error("Erro histórico chat:", err.message); 
        }
    });

    socket.on('enviar_mensagem', async (data) => {
        const { mensagem, salaId, arquivo, tipo_arquivo } = data; 
        const nomeUsuario = data.nome || data.usuario || "Usuário";
        
        if (!salaId || (!mensagem && !arquivo)) return;

        // VALIDAÇÃO DE TRAVA: Se for admin, só pode enviar se for o dono da sessão ativa
        if (socket.rooms.has('admin_room')) {
            const sessao = activeSessions[salaId];
            if (!sessao || sessao.socketId !== socket.id) {
                socket.emit('erro_chat', { mensagem: "Você não pode enviar mensagens. Este usuário já está sendo atendido por " + (sessao ? sessao.nomeAtendente : "outro suporte") + "." });
                return;
            }
        }

        try {
            await pool.query(
                "INSERT INTO mensagens_suporte (sala_id, usuario, texto, arquivo, tipo_arquivo) VALUES ($1, $2, $3, $4, $5)", 
                [salaId, nomeUsuario, mensagem || null, arquivo || null, tipo_arquivo || null]
            );

            const msgData = { 
                usuario: nomeUsuario, 
                texto: mensagem, 
                arquivo: arquivo,
                tipo: tipo_arquivo,
                salaId: salaId, 
                timestamp: new Date()
            };

            io.to(salaId).emit('receber_mensagem', msgData);
            
            // Lógica de notificação seletiva para Admin (Deduplicação de Broadcast)
            const msgMinuscula = (mensagem || "").toLowerCase();
            const pediuHumano = msgMinuscula.includes("humano") || 
                               msgMinuscula.includes("atendente") || 
                               msgMinuscula.includes("ajuda") || 
                               msgMinuscula.includes("suporte");

            // Só envia para a sala geral (admin_room) se o remetente NÃO for admin E não houver suporte ativo
            const isUsuarioComum = nomeUsuario !== "Suporte Arpoador" && nomeUsuario !== "IA Inteligente" && !socket.rooms.has('admin_room');
            console.log(`📩 [MSG] Remetente: ${nomeUsuario} | Usuário Comum: ${isUsuarioComum} | Mensagem: "${mensagem || (arquivo ? '[Arquivo]' : '')}"`);

            if (isUsuarioComum) {
                // Notifica painel geral SÓ SE o chamado estiver sem atendente (unassigned)
                // Se já houver atendente, a mensagem já chegará para ele via salaId (evitando duplicata)
                if (!activeSessions[salaId] || pediuHumano) {
                    io.to('admin_room').emit('receber_mensagem', msgData);
                }
                
                // Gatilho para IA se não houver suporte humano atendendo (TEstando sem Delay)
                if (!activeSessions[salaId] && mensagem) {
                    processarIA(salaId, mensagem);
                }
            }
        } catch (err) { 
            console.error("Erro ao enviar mensagem:", err.message); 
        }
    });

    socket.on('disconnecting', () => {
        for (const salaId of socket.rooms) {
            if (activeSessions[salaId] && activeSessions[salaId].socketId === socket.id) {
                delete activeSessions[salaId];
                io.to('admin_room').emit('usuario_livre', { salaId });
            }
        }
    });

    socket.on('encerrar_chamado', async (salaId) => {
        if (!salaId) return;
        try {
            await pool.query("DELETE FROM mensagens_suporte WHERE sala_id = $1", [salaId]);
            delete activeSessions[salaId];
            io.to(salaId).emit('chamado_encerrado', { salaId });
            // Remove da lista de todos os admins permanentemente
            io.to('admin_room').emit('remover_usuario_lista', { salaId });
            // Força a saída do socket da sala individual (Sincronização Master/Lucas)
            socket.leave(salaId);
        } catch (err) {
            console.error("Erro ao encerrar chamado:", err.message);
        }
    });
});

// --- FUNÇÃO AUXILIAR E-MAIL ---
async function enviarEmail(emailDestino, assunto, html) {
    if (!process.env.BREVO_API_KEY) {
        console.warn("⚠️ BREVO_API_KEY não definida.");
        return;
    }
    try {
        const sendSmtpEmail = new Brevo.SendSmtpEmail();
        sendSmtpEmail.subject = assunto;
        sendSmtpEmail.htmlContent = html;
        sendSmtpEmail.sender = { name: "Gateway SUS", email: "gestaoinformacaodhs@gmail.com" };
        sendSmtpEmail.to = [{ email: emailDestino }];
        await apiInstance.sendTransacEmail(sendSmtpEmail);
    } catch (e) { 
        console.error("❌ Erro e-mail:", e.message); 
    }
}

// --- HEALTH CHECK (usado pelo keep-alive interno) ---
app.get('/health', async (req, res) => {
    try {
        if (pool) {
            await pool.query('SELECT 1');
        }
        res.json({ status: 'ok', ts: Date.now() });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'DB not available', ts: Date.now() });
    }
});

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/registrar', authLimiter, async (req, res) => {
    const { nome, email, senha, role } = req.body;
    console.log(`📝 [DEBUG] Iniciando registro para: ${email} (Role: ${role})`);
    
    if (!nome || !email || !senha) {
        console.warn("⚠️ [DEBUG] Campos obrigatórios ausentes");
        return res.status(400).json({ error: "Campos obrigatórios ausentes." });
    }

    if (!emailValidator.validate(email)) {
        console.warn("⚠️ [DEBUG] E-mail inválido");
        return res.status(400).json({ error: "E-mail inválido." });
    }

    const emailFormatado = email.toLowerCase().trim();

    try {
        console.log("🔐 [DEBUG] Gerando hash da senha...");
        const hash = await bcrypt.hash(senha, 10);
        
        console.log(`🔍 [DEBUG] Verificando existência de: ${emailFormatado}`);
        if (!pool) throw new Error("Banco de dados não configurado (Pool nulo)");
        
        const check = await pool.query("SELECT id, role FROM usuarios WHERE email = $1", [emailFormatado]);
        console.log(`📊 [DEBUG] Resultado verificação: ${check.rows.length} usuários encontrados`);
        
        if (check.rows.length > 0) {
            if (role === 'support') {
                console.log(`⬆️ [DEBUG] Promovendo usuário para suporte: ${emailFormatado}`);
                await pool.query(
                    "UPDATE usuarios SET role = 'support', nome = $1, senha = $2 WHERE email = $3",
                    [nome, hash, emailFormatado]
                );
                console.log("✅ [DEBUG] Usuário promovido com sucesso");
                return res.json({ message: "Usuário existente promovido a Atendente com sucesso!" });
            } else {
                console.warn(`🛑 [DEBUG] E-mail já cadastrado: ${emailFormatado}`);
                return res.status(400).json({ error: "E-mail já cadastrado." });
            }
        }

        console.log(`🆕 [DEBUG] Criando novo usuário: ${emailFormatado}`);
        await pool.query(
            "INSERT INTO usuarios (nome, email, senha, ativo, role) VALUES ($1, $2, $3, 1, $4)",
            [nome, emailFormatado, hash, role || 'user']
        );
        console.log("✅ [DEBUG] Novo usuário criado com sucesso");
        res.json({ message: "Conta criada com sucesso!" });
    } catch (err) {
        console.error("❌ [DEBUG] Erro crítico no registro:", err.message);
        res.status(500).json({ error: "Erro interno no servidor: " + err.message });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: "E-mail e senha são obrigatórios." });

    try {
        const result = await pool.query(`SELECT id, nome, email, senha, ativo, role FROM usuarios WHERE email = $1`, [email.toLowerCase().trim()]);
        const user = result.rows[0];
        
        if (!user) {
            console.log(`Tentativa de login falhou: Usuário ${email} não encontrado.`);
            return res.status(401).json({ error: "Credenciais inválidas." });
        }

        const match = await bcrypt.compare(senha, user.senha);
        if (!match) {
            console.log(`Tentativa de login falhou: Senha incorreta para ${email}.`);
            return res.status(401).json({ error: "Credenciais inválidas." });
        }

        const jwtSecret = process.env.JWT_SECRET || 'mu42x9!k_magadon';
        const csrfToken = crypto.randomBytes(16).toString('hex');
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role, csrfToken }, jwtSecret, { expiresIn: '12h' });

        res.json({
            user: user.nome,
            email: user.email,
            role: user.role,
            token,
            csrfToken,
            expiresIn: 43200
        });
    } catch (err) { 
        res.status(500).json({ error: "Erro no servidor." }); 
    }
});

const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];
    const csrfHeader = req.headers['x-csrf-token'];

    if (!token) return res.status(401).json({ error: 'Token JWT ausente.' });

    try {
        const jwtSecret = process.env.JWT_SECRET || 'mu42x9!k_magadon';
        const payload = jwt.verify(token, jwtSecret);

        if (req.method !== 'GET' && req.method !== 'HEAD' && payload.csrfToken !== csrfHeader) {
            return res.status(403).json({ error: 'Token CSRF inválido.' });
        }

        req.user = payload;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
};

app.post('/api/update-profile', verifyToken, async (req, res) => {
    const { nome, novaSenha } = req.body;
    const emailFormatado = req.user.email.toLowerCase().trim();
    try {
        if (novaSenha && novaSenha.trim() !== "") {
            const hash = await bcrypt.hash(novaSenha, 10);
            await pool.query(
                "UPDATE usuarios SET nome = $1, senha = $2 WHERE email = $3",
                [nome, hash, emailFormatado]
            );
        } else {
            await pool.query(
                "UPDATE usuarios SET nome = $1 WHERE email = $2",
                [nome, emailFormatado]
            );
        }
        res.json({ message: "Perfil atualizado com sucesso!" });
    } catch (err) {
        res.status(500).json({ error: "Erro ao atualizar perfil." });
    }
});

app.post('/api/delete-account', verifyToken, async (req, res) => {
    const { email } = req.body;
    const userEmail = req.user.email.toLowerCase().trim();

    if (email.toLowerCase().trim() !== userEmail) {
        return res.status(403).json({ error: "Você só pode excluir sua própria conta." });
    }

    try {
        await pool.query("DELETE FROM usuarios WHERE email = $1", [userEmail]);
        res.json({ message: "Conta excluída com sucesso." });
    } catch (err) {
        console.error("Erro ao excluir conta:", err.message);
        res.status(500).json({ error: "Erro interno ao excluir conta." });
    }
});

app.get('/api/balance', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT balance FROM usuarios WHERE id = $1', [req.user.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
        res.json({ balance: Number(result.rows[0].balance || 0).toFixed(2) });
    } catch (err) {
        console.error('Erro /api/balance:', err.message);
        res.status(500).json({ error: 'Erro ao consultar saldo.' });
    }
});

app.get('/api/stripe-config', verifyToken, async (req, res) => {
    if (!stripe) return res.status(500).json({ error: 'Stripe não configurado (STRIPE_SECRET_KEY ausente).' });
    res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
});

app.post('/api/create-checkout-session', verifyToken, async (req, res) => {
    if (!stripe) return res.status(500).json({ error: 'Stripe não configurado (STRIPE_SECRET_KEY ausente).' });

    const { amount } = req.body;
    const valor = parseFloat(amount);
    if (Number.isNaN(valor) || valor <= 0) return res.status(400).json({ error: 'Valor inválido.' });

    const baseUrl = process.env.BASE_URL || 'https://gateway-datasus.onrender.com';

    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
            price_data: {
                currency: 'brl',
                product_data: { name: 'Depósito de saldo Gateway DATASUS' },
                unit_amount: Math.round(valor * 100)
            },
            quantity: 1
        }],
        mode: 'payment',
        success_url: `${baseUrl}/wallet.html?payment=success`,
        cancel_url: `${baseUrl}/wallet.html?payment=cancelled`,
        metadata: {
            user_id: req.user.id,
            email: req.user.email,
            transacao_tipo: 'deposit'
        }
    });

    await pool.query(
        'INSERT INTO transacoes (usuario_id, tipo, valor, status, descricao, referencia) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.user.id, 'deposit', valor, 'pending', 'Depósito via Stripe Checkout', `stripe-${session.id}`]
    );

    res.json({ sessionId: session.id });
});

app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) return res.status(500).send('Stripe não configurado');

    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(500).send('Webhook secret não configurado');

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook Stripe inválido:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        const email = session.metadata?.email;
        const amount = session.amount_total / 100;

        try {
            const userRes = userId ? await pool.query('SELECT id, balance FROM usuarios WHERE id = $1', [userId]) : await pool.query('SELECT id, balance FROM usuarios WHERE email = $1', [email]);
            if (userRes.rows.length === 0) return res.status(404).send('Usuário não encontrado');

            const user = userRes.rows[0];
            const txRes = await pool.query('SELECT id, status FROM transacoes WHERE referencia = $1', [`stripe-${session.id}`]);

            if (txRes.rows.length > 0 && txRes.rows[0].status !== 'completed') {
                const novoSaldo = parseFloat(user.balance || 0) + parseFloat(amount);
                await pool.query('UPDATE usuarios SET balance = $1 WHERE id = $2', [novoSaldo, user.id]);
                await pool.query('UPDATE transacoes SET status = $1 WHERE id = $2', ['completed', txRes.rows[0].id]);
            }

            await pool.query('INSERT INTO transacoes (usuario_id, tipo, valor, status, descricao, referencia) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING', [user.id, 'deposit', amount, 'completed', 'Depósito confirmado Stripe', `stripe-confirm-${session.id}`]);
        } catch (err) {
            console.error('Erro ao processar webhook stripe:', err.message);
            return res.status(500).send('Erro interno');
        }
    }

    res.json({ received: true });
});

app.post('/api/deposit', verifyToken, async (req, res) => {
    const { amount } = req.body;
    const valor = parseFloat(amount);
    if (Number.isNaN(valor) || valor <= 0) return res.status(400).json({ error: 'Valor de depósito inválido.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const user = await client.query('SELECT balance FROM usuarios WHERE id = $1 FOR UPDATE', [req.user.id]);
        if (user.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const novoSaldo = parseFloat(user.rows[0].balance || 0) + valor;
        await client.query('UPDATE usuarios SET balance = $1 WHERE id = $2', [novoSaldo, req.user.id]);

        await client.query(
            'INSERT INTO transacoes (usuario_id, tipo, valor, status, descricao, referencia) VALUES ($1, $2, $3, $4, $5, $6)',
            [req.user.id, 'deposit', valor, 'completed', 'Depósito via sistema', `deposit-${Date.now()}`]
        );

        await client.query('COMMIT');
        res.json({ message: 'Depósito realizado com sucesso.', balance: novoSaldo.toFixed(2) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro /api/deposit:', err.message);
        res.status(500).json({ error: 'Erro ao processar depósito.' });
    } finally {
        client.release();
    }
});

app.get('/api/transactions', verifyToken, async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    try {
        const result = await pool.query(
            'SELECT id, tipo, valor, status, descricao, referencia, criado_em FROM transacoes WHERE usuario_id = $1 ORDER BY criado_em DESC LIMIT $2 OFFSET $3',
            [req.user.id, limit, offset]
        );
        res.json({ transactions: result.rows });
    } catch (err) {
        console.error('Erro /api/transactions:', err.message);
        res.status(500).json({ error: 'Erro ao buscar extrato.' });
    }
});

app.post('/api/refund', verifyToken, async (req, res) => {
    const { transactionId } = req.body;
    if (!transactionId) return res.status(400).json({ error: 'ID da transação obrigatório.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const trans = await client.query('SELECT * FROM transacoes WHERE id = $1 AND usuario_id = $2 FOR UPDATE', [transactionId, req.user.id]);
        if (trans.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Transação não encontrada.' });
        }
        const tx = trans.rows[0];

        if (tx.tipo !== 'deposit' || tx.status !== 'completed') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Somente depósitos concluídos podem ser estornados.' });
        }

        const user = await client.query('SELECT balance FROM usuarios WHERE id = $1 FOR UPDATE', [req.user.id]);
        const saldoAtual = parseFloat(user.rows[0].balance || 0);

        if (saldoAtual < parseFloat(tx.valor)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Saldo insuficiente para estorno.' });
        }

        const novoSaldo = saldoAtual - parseFloat(tx.valor);
        await client.query('UPDATE usuarios SET balance = $1 WHERE id = $2', [novoSaldo, req.user.id]);

        await client.query('UPDATE transacoes SET status = $1 WHERE id = $2', ['refunded', tx.id]);

        await client.query('INSERT INTO transacoes (usuario_id, tipo, valor, status, descricao, referencia) VALUES ($1, $2, $3, $4, $5, $6)',
            [req.user.id, 'refund', -Math.abs(tx.valor), 'completed', `Estorno da transação ${tx.id}`, `refund-${tx.id}-${Date.now()}`]);

        await client.query('COMMIT');
        res.json({ message: 'Estorno realizado com sucesso.', balance: novoSaldo.toFixed(2) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro /api/refund:', err.message);
        res.status(500).json({ error: 'Erro ao processar estorno.' });
    } finally {
        client.release();
    }
});

app.post('/api/withdraw', verifyToken, async (req, res) => {
    const { amount } = req.body;
    const valor = parseFloat(amount);
    if (Number.isNaN(valor) || valor <= 0) return res.status(400).json({ error: 'Valor de saque inválido.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const user = await client.query('SELECT balance FROM usuarios WHERE id = $1 FOR UPDATE', [req.user.id]);
        if (user.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const saldoAtual = parseFloat(user.rows[0].balance || 0);
        if (saldoAtual < valor) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Saldo insuficiente para saque.' });
        }

        const novoSaldo = saldoAtual - valor;
        await client.query('UPDATE usuarios SET balance = $1 WHERE id = $2', [novoSaldo, req.user.id]);

        await client.query('INSERT INTO transacoes (usuario_id, tipo, valor, status, descricao, referencia) VALUES ($1, $2, $3, $4, $5, $6)',
            [req.user.id, 'withdraw', -valor, 'completed', 'Saque via sistema', `withdraw-${Date.now()}`]);

        await client.query('COMMIT');
        res.json({ message: 'Saque realizado com sucesso.', balance: novoSaldo.toFixed(2) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro /api/withdraw:', err.message);
        res.status(500).json({ error: 'Erro ao processar saque.' });
    } finally {
        client.release();
    }
});

app.post('/api/pix', verifyToken, async (req, res) => {
    const { amount, pixKey } = req.body;
    const valor = parseFloat(amount);
    if (Number.isNaN(valor) || valor <= 0) return res.status(400).json({ error: 'Valor PIX inválido.' });
    if (!pixKey || typeof pixKey !== 'string' || pixKey.trim().length === 0) return res.status(400).json({ error: 'Chave PIX obrigatória.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const user = await client.query('SELECT balance FROM usuarios WHERE id = $1 FOR UPDATE', [req.user.id]);
        if (user.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const saldoAtual = parseFloat(user.rows[0].balance || 0);
        if (saldoAtual < valor) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Saldo insuficiente para transferência PIX.' });
        }

        const novoSaldo = saldoAtual - valor;
        await client.query('UPDATE usuarios SET balance = $1 WHERE id = $2', [novoSaldo, req.user.id]);

        await client.query('INSERT INTO transacoes (usuario_id, tipo, valor, status, descricao, referencia) VALUES ($1, $2, $3, $4, $5, $6)',
            [req.user.id, 'pix', -valor, 'completed', `PIX para ${pixKey}`, `pix-${Date.now()}`]);

        await client.query('COMMIT');
        res.json({ message: 'PIX realizado com sucesso.', balance: novoSaldo.toFixed(2) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erro /api/pix:', err.message);
        res.status(500).json({ error: 'Erro ao processar PIX.' });
    } finally {
        client.release();
    }
});

app.post('/api/recuperar-senha-master', async (req, res) => {
    const { email } = req.body;
    const adminEmail = "gestaoinformacaodhs@gmail.com";

    if (email.toLowerCase().trim() !== adminEmail) {
        return res.status(403).json({ error: "E-mail administrativo não reconhecido." });
    }

    try {
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000); // 1 hora
        
        await pool.query(
            "UPDATE usuarios SET reset_token = $1, reset_expiracao = $2 WHERE email = $3",
            [token, expiracao, adminEmail]
        );

        const link = `https://gateway-datasus.onrender.com/reset-password.html?token=${token}`;
        const html = `
            <h2>Recuperação de Acesso Master</h2>
            <p>Você solicitou a recuperação da senha administrativa do Gateway SUS.</p>
            <p>Clique no link abaixo para definir uma nova senha:</p>
            <a href="${link}">${link}</a>
            <p>Este link expira em 1 hora.</p>
        `;

        await enviarEmail(adminEmail, "Recuperação de Senha Master - Gateway SUS", html);
        res.json({ message: "Instruções de recuperação enviadas para o e-mail master." });
    } catch (err) {
        res.status(500).json({ error: "Erro ao processar recuperação master." });
    }
});

app.post('/api/delete-account', verifyToken, async (req, res) => {
    const userId = req.user.id;
    if (!userId) return res.status(400).json({ error: "Usuário não autenticado." });

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        const user = await client.query('SELECT email FROM usuarios WHERE id = $1', [userId]);
        if (user.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        }

        const emailFormatado = user.rows[0].email;
        await client.query("DELETE FROM mensagens_suporte WHERE usuario = $1 OR sala_id = $1", [emailFormatado]);
        const result = await client.query("DELETE FROM usuarios WHERE id = $1", [userId]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Usuário não encontrado." });
        }

        await client.query('COMMIT');
        res.json({ message: "Conta e histórico removidos com sucesso." });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: "Erro interno ao processar exclusão." });
    } finally {
        client.release();
    }
});

app.get('/api/admin/atendentes', async (req, res) => {
    try {
        if (!pool) {
            console.warn("⚠️ [DB] Tentativa de listar atendentes sem pool configurado.");
            return res.json([]); // Retorna lista vazia se não houver banco
        }
        const result = await pool.query("SELECT nome, email FROM usuarios WHERE role = 'support' ORDER BY nome ASC");
        res.json(result.rows);
    } catch (err) {
        console.error("❌ Erro ao listar atendentes:", err.message);
        res.status(500).json({ error: "Erro ao carregar lista de atendentes: " + err.message });
    }
});

app.post('/api/admin/deletar-atendente', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "E-mail do atendente é obrigatório." });

    try {
        if (!pool) throw new Error("Banco de dados não configurado.");
        
        const result = await pool.query("DELETE FROM usuarios WHERE email = $1 AND role = 'support'", [email.toLowerCase().trim()]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ error: "Atendente não encontrado ou não possui permissão de suporte." });
        }

        res.json({ message: "Atendente removido com sucesso!" });
    } catch (err) {
        console.error("❌ Erro ao deletar atendente:", err.message);
        res.status(500).json({ error: "Erro interno ao remover atendente." });
    }
});

app.post('/api/recuperar-senha', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "E-mail obrigatório." });

    try {
        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000); 
        const result = await pool.query(
            "UPDATE usuarios SET reset_token = $1, reset_expiracao = $2 WHERE email = $3 RETURNING nome",
            [token, expiracao, email.toLowerCase().trim()]
        );
        
        if (result.rowCount > 0) {
            const link = `https://gateway-datasus.onrender.com/reset-password.html?token=${token}`;
            const html = `<p>Olá ${result.rows[0].nome}, redefina sua senha clicando no link abaixo:</p><p><a href="${link}">${link}</a></p>`;
            await enviarEmail(email, "Recuperação de Senha - Gateway SUS", html);
        }
        res.json({ message: "Se o e-mail existir, as instruções foram enviadas." });
    } catch (err) { 
        res.status(500).json({ error: "Erro ao processar recuperação." }); 
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, novaSenha } = req.body;
    try {
        const result = await pool.query("SELECT id, reset_expiracao FROM usuarios WHERE reset_token = $1", [token]);
        if (result.rows.length === 0) return res.status(400).json({ error: "Token inválido." });

        const usuario = result.rows[0];
        if (new Date() > new Date(usuario.reset_expiracao)) return res.status(400).json({ error: "Link expirado." });
        
        const hash = await bcrypt.hash(novaSenha, 10);
        await pool.query(
            "UPDATE usuarios SET senha = $1, reset_token = NULL, reset_expiracao = NULL WHERE id = $2", 
            [hash, usuario.id]
        );
        res.json({ message: "Senha atualizada!" });
    } catch (err) { 
        res.status(500).json({ error: "Erro ao salvar nova senha." }); 
    }
});

// --- ROTA DE NAVEGAÇÃO SIOPS ---
app.get('/siops', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'siops.html'));
});

app.get('/wallet', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'wallet.html'));
});

// --- PROXY SIASUS PARA INTEGRAÇÃO NATIVA MESTRE ---
async function handleSiaProxy(req, res, targetUrl) {
    console.log("Proxying request to:", targetUrl);
    if (!targetUrl) return res.status(400).send("No URL provided");
    if (!targetUrl.startsWith('http')) {
        targetUrl = 'http://sia.datasus.gov.br' + (targetUrl.startsWith('/') ? '' : '/') + targetUrl;
    }

    try {
        const fetchMethod = global.fetch; // Node 18+ nativo
        
        // Verifica primeiro se a rota que chamou é sihd-proxy, caso contrário checa se a URL tem sihd explicitamente
        let baseDomain = 'sia.datasus.gov.br';
        if (targetUrl.startsWith('http')) {
            try {
                const urlObj = new URL(targetUrl);
                baseDomain = urlObj.hostname;
            } catch(e) { /* ignore invalid url */ }
        } else if (req.originalUrl.includes('sihd-proxy') || targetUrl.includes('sihd.datasus')) {
            baseDomain = 'sihd.datasus.gov.br';
        }

        if (targetUrl.startsWith('/')) {
            targetUrl = `http://${baseDomain}${targetUrl}`;
        }
        
        let options = {
            method: req.method,
            redirect: 'follow',
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': `http://${baseDomain}/`,
                'Cookie': req.headers.cookie || ''
            }
        };

        let myNewSetCookies = [];
        
        // Anti-DDoS e Prevenção de Ghost Session em Arquivos Estáticos!
        const isAsset = targetUrl.match(/\.(png|gif|jpg|jpeg|css|js|woff|woff2|ico)$/i) || targetUrl.includes('/imagens/') || targetUrl.includes('/css/') || targetUrl.includes('/js/') || targetUrl.includes('/funcoes/');
        
        // Criar Sessão Fantasma se o usuário ainda não tiver uma e NÃO for requisição de recurso estático
        if (!isAsset && !options.headers['Cookie'].includes('PHPSESSID')) {
            try {
                const ac = new AbortController();
                const initTimeout = setTimeout(() => ac.abort(), 10000);
                const initRes = await fetchMethod(`http://${baseDomain}/principal/index.php`, { method: 'GET', headers: { 'User-Agent': options.headers['User-Agent'] }, signal: ac.signal });
                clearTimeout(initTimeout);
                
                let setCookiesInit = [];
                if (initRes.headers.getSetCookie) setCookiesInit = initRes.headers.getSetCookie();
                else if (initRes.headers.raw && initRes.headers.raw()['set-cookie']) setCookiesInit = initRes.headers.raw()['set-cookie'];
                
                let newCookies = options.headers['Cookie'] ? options.headers['Cookie'].split('; ') : [];
                setCookiesInit.forEach(c => {
                    newCookies.push(c.split(';')[0]); 
                    myNewSetCookies.push(c.replace(/domain=[^;]+/gi, '')); 
                });
                options.headers['Cookie'] = newCookies.join('; ');
            } catch(e) { console.error("Initial Session Error (Ignored):", e.message); }
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const bodyParams = new URLSearchParams();
            for (const key in req.body) {
                bodyParams.append(key, req.body[key]);
            }
            options.body = bodyParams.toString();
            options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        const controller = new AbortController();
        const mainTimeout = setTimeout(() => controller.abort(), 20000); // 20 sec limit to prevent hangs
        options.signal = controller.signal;

        let response;
        try {
            if (baseDomain.includes('msbbs')) {
                // MS-BBS fallback usando o módulo HTTP nativo com host e path explícitos
                const http = require('http');
                const urlObj = new URL(targetUrl);
                return new Promise((resolve, reject) => {
                    const reqBbs = http.get({
                        hostname: urlObj.hostname,
                        port: 80,
                        path: urlObj.pathname + urlObj.search,
                        insecureHTTPParser: true,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Host': urlObj.hostname
                        }
                    }, (httpRes) => {
                        let data = [];
                        httpRes.on('data', chunk => data.push(chunk));
                        httpRes.on('end', () => {
                            const buffer = Buffer.concat(data);
                            const contentType = httpRes.headers['content-type'] || 'text/html';
                            
                            if (contentType.includes('text/html')) {
                                res.set('Content-Type', 'text/html; charset=latin1');
                                let html = buffer.toString('latin1');
                                // Injeção de CSS e correções
                                let modifiedHtml = html.replace(/<head>/i, `<head>
                                <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
                                <style>
                                    body, html { background-color: #111827 !important; color: #cbd5e1 !important; font-family: 'Inter', sans-serif !important; }
                                    img[src*="topo_sia"], #rodape, #testeira, #testeira2 { display: none !important; }
                                </style>
                                <script>
                                    document.addEventListener('click', function(e) {
                                        let t = e.target.closest('a');
                                        if (t && t.href && !t.href.includes('javascript') && !t.href.startsWith('#')) {
                                            if (t.target === '_blank') t.target = '_self';
                                        }
                                    });
                                </script>`);
                            modifiedHtml = modifiedHtml.replace(/<\/body>/i, `<div id="resultteste" style="display:none"></div></body>`);
                            
                            // Remover target="_blank"
                            modifiedHtml = modifiedHtml.replace(/target=["']_blank["']/gi, 'target="_self"');

                            // Correção massiva de links para o MS-BBS
                            modifiedHtml = modifiedHtml.replace(/(href|src|action)=["'](?!javascript|#|mailto|data:)(([^"']+))["']/gi, (match, type, p1) => {
                                if (p1.startsWith('http')) {
                                    if (p1.includes('.datasus.gov.br')) {
                                         return `${type}="/api/sia-proxy?url=${encodeURIComponent(p1)}"`;
                                    }
                                    return match; 
                                }
                                if (p1.startsWith('/')) {
                                    return `${type}="/api/sia-proxy?url=${encodeURIComponent('http://' + urlObj.hostname + p1)}"`;
                                }
                                let baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                                return `${type}="/api/sia-proxy?url=${encodeURIComponent(baseUrl + p1)}"`;
                            });

                            res.send(modifiedHtml);
                        } else {
                            // Conteúdo binário (imagens, etc)
                            res.set('Content-Type', contentType);
                            res.set('Cache-Control', 'public, max-age=3600');
                            res.send(buffer);
                        }
                        resolve();
                        });
                    });
                    
                    reqBbs.on('error', e => {
                        console.error("HTTP Fallback Error for MS-BBS:", e);
                        res.status(500).send("Erro no MS-BBS: " + e.message);
                        reject(e);
                    });
                });
            }
            
            response = await fetchMethod(targetUrl, options);
        } catch(fetchError) {
            clearTimeout(mainTimeout);
            throw fetchError;
        }
        clearTimeout(mainTimeout);
        
        const finalUrl = response.url;
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        
        let contentType = response.headers.get('content-type') || '';
        
        // Pass new cookies to the browser
        let setCookies = [];
        if (response.headers.getSetCookie) setCookies = response.headers.getSetCookie();
        else if (response.headers.raw && response.headers.raw()['set-cookie']) setCookies = response.headers.raw()['set-cookie'];
        setCookies.forEach(c => myNewSetCookies.push(c.replace(/domain=[^;]+/gi, '')));
        if (myNewSetCookies.length > 0) res.setHeader('Set-Cookie', myNewSetCookies);

        // Se NÃO FOR HTML (ex: js, png, chamadas AJAX em JSON/XML), retorna direto sem modificar!
        if (!contentType.includes('text/html')) {
            res.set('Content-Type', contentType);
            // Se for script ou style e o status for erro, retornar vazio para evitar SyntaxError no browser
            if (!response.ok && (contentType.includes('javascript') || contentType.includes('css'))) {
                return res.status(response.status).send('');
            }
            return res.send(buffer);
        }

        let html = buffer.toString('latin1');
        
        // TRATAMENTO DE HTML — sem <base> tag para evitar Mixed Content!
        let modifiedHtml = html.replace(/<head>/i, `<head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
        <style>
            body, html { background-color: #111827 !important; color: #cbd5e1 !important; font-family: 'Inter', sans-serif !important; margin: 0; padding: 0; overflow: auto; min-height: 100vh; }
            * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
            *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
            table, td, th { background-color: #1e293b !important; color: #cbd5e1 !important; border-color: #334155 !important; }
            a { color: #3b82f6 !important; text-decoration: none; font-weight: bold; }
            a:hover { color: #60a5fa !important; text-decoration: underline; }
            .conteudo, .tabela1, .tabela2, .box, div, span, p, font { background: transparent !important; border-color: #334155 !important; color: #cbd5e1 !important; }
            img[src*="topo_sia"], map, area, table[width="766"] > tbody > tr:first-child, table[width="766"] > tbody > tr:nth-child(2), td[background*="menu_fundo"], div[align="center"] > img, img[src*="menu"], #barra_submenu, .item_submenu, .item_submenu2, .ms_caixa_topo_meio, .menu, #rodape, #rodape2, #rodape3, #destaquegov, #destaquesGoverno, #testeira, #testeira2 { display: none !important; }
            
            select, input[type="text"], input[type="submit"], input[type="button"], button {
                background-color: #1e293b !important; color: #f8fafc !important; border: 1px solid #334155 !important; padding: 8px 16px !important; border-radius: 8px !important; font-family: inherit !important; outline: none !important; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1) !important; margin: 4px; background-image: none !important;
            }
            select option { background-color: #1e293b !important; color: #f8fafc !important; }
            input[type="submit"], input[type="button"], button, .botao { background-color: #2563eb !important; font-weight: 700 !important; cursor: pointer !important; transition: all 0.2s !important; border: none !important; }
            input[type="submit"]:hover, input[type="button"]:hover, button:hover { background-color: #3b82f6 !important; transform: translateY(-1px) !important; }
            .titulo_aj, .box_destaque { color: #60a5fa !important; font-size: 1.1rem !important; margin-bottom: 12px !important; border-bottom: 1px solid #334155 !important; padding-bottom: 8px !important; }
            fieldset { border: 1px solid #334155 !important; border-radius: 8px !important; padding: 16px !important; margin-top: 10px !important; }
            legend { color: #94a3b8 !important; font-weight: bold !important; padding: 0 8px !important; }
            .tabela_fundo { background-color: #111827 !important; }
            .titulo_tabela, .titulo { background-color: #2563eb !important; color: #fff !important; padding: 4px; border-radius: 4px; }
            td[bgcolor], th[bgcolor] { background-color: #1e293b !important; }
        </style>`);

        // Inject missing elements to avoid legacy JS crashes
        modifiedHtml = modifiedHtml.replace(/<\/body>/i, `<div id="resultteste" style="display:none"></div></body>`);

        // Correção massiva também para scripts (src), forms (action) e hrefs!
        modifiedHtml = modifiedHtml.replace(/(href|src|action)=["'](?!javascript|#|mailto|data:)(([^"']+))["']/gi, (match, type, p1) => {
            const lowerP1 = p1.toLowerCase();
            const proxyApiRoute = targetUrl.includes('sihd.datasus') ? '/api/sihd-proxy' : '/api/sia-proxy';

            if (p1.startsWith('ftp://')) {
                return `href="/api/ftp-download?url=${encodeURIComponent(p1)}"`;
            }
            
            // Tratamento de arquivos para download direto
            if (type === 'href' && (lowerP1.endsWith('.zip') || lowerP1.endsWith('.exe') || lowerP1.endsWith('.pdf') || lowerP1.endsWith('.doc') || lowerP1.endsWith('.xls'))) {
                try {
                    const absUrl = new URL(p1, finalUrl).href;
                    return `href="${absUrl}" target="_blank"`;
                } catch(e) { return match; }
            }

            // Não proxia links externos (Google, etc.)
            if (p1.startsWith('http')) {
                if (p1.includes('.datasus.gov.br')) {
                     return `${type}="${proxyApiRoute}?url=${encodeURIComponent(p1)}"`;
                }
                return match; 
            }

            // Links relativos ou absolutos da raiz do DATASUS
            try {
                const absUrl = new URL(p1, finalUrl).href;
                if (absUrl.includes('.datasus.gov.br')) {
                    return `${type}="${proxyApiRoute}?url=${encodeURIComponent(absUrl)}"`;
                }
                return `${type}="${absUrl}"`;
            } catch(e) {
                return match;
            }
        });

        res.send(modifiedHtml);
    } catch (e) {
        console.error("Proxy error for", targetUrl, ":", e);
        
        // Se NÃO FOR HTML, não retorna erro em HTML
        const isHtml = targetUrl.toLowerCase().includes('.html') || targetUrl.toLowerCase().includes('.php') || !targetUrl.includes('.');
        if (!isHtml) {
            return res.status(500).send('');
        }

        res.status(500).send(`<div style="color:white; font-family:sans-serif; text-align:center; padding: 20px;">
            <h2>Erro de Integração</h2><p>Falha ao conectar no DATASUS: ${e.message}</p>
            <p style="font-size: 10px; opacity: 0.5;">URL: ${targetUrl}</p></div>`);
    }
}

app.all('/api/sia-proxy', (req, res) => handleSiaProxy(req, res, req.query.url));

app.all('/api/sihd-proxy', (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL is required');
    
    if (!targetUrl.startsWith('http')) {
        targetUrl = `http://sihd.datasus.gov.br${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;
    }
    
    handleSiaProxy(req, res, targetUrl);
});

// --- FIM DA INTERCEPTAÇÃO ESTATICA, O WILDCARD FARÁ O TRABALHO ---

// --- DOWNLOAD DIRETO DE ARQUIVOS FTP DATASUS ---
app.get('/api/ftp-download', downloadLimiter, async (req, res) => {
    const ftpUrl = req.query.url;
    if (!ftpUrl || !ftpUrl.startsWith('ftp://')) {
        return res.status(400).send('URL FTP inválida.');
    }

    // Parsear a URL FTP: ftp://host/path/to/file.ext
    let parsed = ftpUrl.replace('ftp://', '');
    const slashIdx = parsed.indexOf('/');
    const host = parsed.substring(0, slashIdx);
    const remotePath = parsed.substring(slashIdx);
    const filename = remotePath.split('/').pop() || 'download';

    const client = new ftp.Client();
    client.ftp.verbose = false;

    try {
        await client.access({ host, port: 21, user: 'anonymous', password: 'anonymous@' });

        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/octet-stream');

        const passThrough = new PassThrough();
        passThrough.pipe(res);

        await client.downloadTo(passThrough, remotePath);
    } catch (err) {
        console.error('FTP Download error:', err.message);
        if (!res.headersSent) {
            res.status(500).send(`Erro ao baixar arquivo FTP: ${err.message}`);
        }
    } finally {
        client.close();
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

    const client = new ftp.Client(30000); 
    try {
        await client.access({ host: getFtpHost(sistema), user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        const data = list.filter(f => f.isFile).map(f => ({ 
            name: f.name, 
            size: (f.size / 1024 / 1024).toFixed(2) + " MB",
            rawDate: f.modifiedAt 
        })).sort((a, b) => new Date(b.rawDate) - new Date(a.rawDate));
        
        cacheFTP[sistema] = { time: agora, data: data };
        res.json(data);
    } catch (e) { 
        console.error(`Erro FTP (${sistema}):`, e.message);
        res.status(500).json({ error: "FTP DATASUS instável no momento." }); 
    } finally { 
        client.close(); 
    }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const sisUpper = sistema.toUpperCase();
    
    if (!pastasFTP[sisUpper]) return res.status(400).send("Sistema inválido.");

    const client = new ftp.Client(60000); 
    try {
        const nomeArquivo = decodeURIComponent(arquivo);
        if (nomeArquivo.includes('..') || nomeArquivo.includes('/')) {
            return res.status(403).send("Acesso negado.");
        }

        await client.access({ host: getFtpHost(sisUpper), user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sisUpper]);
        
        res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        const tunnel = new PassThrough();
        tunnel.pipe(res);
        
        tunnel.on('error', (err) => {
            console.error("Erro no stream de download:", err.message);
        });

        await client.downloadTo(tunnel, nomeArquivo);
    } catch (e) { 
        console.error("Erro no download:", e.message);
        if (!res.headersSent) res.status(500).send("Erro ao processar download."); 
    } finally { 
        client.close(); 
    }
});

// --- WILDCARD PROXY FALLBACK (Resolve URLs perdidas) ---
app.all('*', (req, res, next) => {
    // Ignorar requisições que pertencem definitivamente à nossa API ou WebSockets
    if (req.originalUrl.startsWith('/api/') || req.originalUrl.startsWith('/socket.io/')) {
        return next();
    }
    
    // Fallback: se nenhuma rota bateu E o referer indica que veio de dentro do proxy (sihd ou sia)
    // Isso evita que paginas normais do gateway (.html) sejam erroneamente encaminhadas ao DATASUS
    const referer = req.headers.referer || '';
    const fromProxy = referer.includes('sihd-proxy') || referer.includes('sia-proxy') || referer.includes('sihd.datasus') || referer.includes('sia.datasus');
    
    if (!fromProxy) {
        // Não é do proxy — deixa retornar 404 padrão do Express
        return res.status(404).send('Not Found');
    }
    
    const targetDomain = (referer.includes('sihd-proxy') || req.originalUrl.includes('sihd')) ? 'sihd.datasus.gov.br' : 'sia.datasus.gov.br';
    
    // Envia pro motor de proxy
    handleSiaProxy(req, res, `http://${targetDomain}${req.originalUrl}`);
});

// --- INICIALIZAÇÃO CORRIGIDA PARA RENDER ---
const PORT = process.env.PORT || 10000; // Render usa 10000 por padrão
server.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Gateway DATASUS rodando na porta ${PORT}`);

    // --- KEEP-ALIVE: evita hibernação no Render (free tier dorme após 15min) ---
    // Usamos 127.0.0.1 em vez de localhost para evitar problemas de IPv6 (::1) no Node 18+
    const PING_URL = `http://127.0.0.1:${PORT}/health`;
    console.log(`💓 Keep-alive ativado → ping a cada 9min em ${PING_URL}`);

    // Primeiro ping imediato para confirmar que está funcionando
    setTimeout(async () => {
        try {
            await fetch(PING_URL);
            console.log(`💓 Keep-alive: primeiro ping OK → ${PING_URL}`);
        } catch (e) {
            console.warn('Keep-alive ping falhou:', e.message);
        }
    }, 5000); // 5 segundos após iniciar

    setInterval(async () => {
        try {
            await fetch(PING_URL);
            console.log(`💓 Keep-alive ping OK → ${new Date().toISOString()}`);
        } catch (e) {
            console.warn('Keep-alive ping falhou:', e.message);
        }
    }, 9 * 60 * 1000); // a cada 9 minutos
});