require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');

// Config & Modules
const logger = require('./src/config/logger');
const { pool, query } = require('./src/config/database');
const apiRoutes = require('./src/routes/apiRoutes');
const errorHandler = require('./src/middlewares/errorHandler');
const AiService = require('./src/services/aiService');

const app = express();
const server = http.createServer(app);

/**
 * --- SEGURANÇA E MIDDLEWARES ---
 */
app.use(helmet({
    contentSecurityPolicy: false, 
    crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static('public'));
app.set('trust proxy', 1);

/**
 * --- ROTAS ---
 */
app.use('/api', apiRoutes);

/**
 * --- SOCKET.IO ---
 */
const io = new Server(server, {
    cors: {
        origin: "*", // Permissive for deployment stability
        methods: ["GET", "POST"],
        credentials: true
    },
    maxHttpBufferSize: 1e7, // 10MB
    transports: ['websocket', 'polling']
});

const activeSessions = {};

io.on('connection', (socket) => {
    logger.info(`New client connected: ${socket.id}`);

    socket.on('entrar_na_sala', async (salaId) => {
        if (!salaId) return;
        socket.join(salaId);
        logger.info(`Socket ${socket.id} joined room: ${salaId}`);
        
        try {
            const hist = await query(
                "SELECT usuario, texto, arquivo, tipo_arquivo as tipo, timestamp FROM mensagens_suporte WHERE sala_id = $1 ORDER BY timestamp ASC LIMIT 50", 
                [salaId]
            );
            socket.emit('historico_mensagens', hist.rows);
        } catch (err) {
            // Only log if it's not a "DB not initialized" error to avoid spamming
            if (!err.message.includes('Database not initialized')) {
                logger.error('Error fetching chat history:', err);
            }
        }
    });

    socket.on('enviar_mensagem', async (data) => {
        const { mensagem, salaId, nome } = data;
        if (!salaId || (!mensagem && !data.arquivo)) return;

        logger.info(`Message in room ${salaId} from ${nome || 'Usuário'}`);

        try {
            await query(
                "INSERT INTO mensagens_suporte (sala_id, usuario, texto, arquivo, tipo_arquivo) VALUES ($1, $2, $3, $4, $5)", 
                [salaId, nome || "Usuário", mensagem || null, data.arquivo || null, data.tipo_arquivo || null]
            );
        } catch (err) {
            if (!err.message.includes('Database not initialized')) {
                logger.error('Error saving message:', err);
            }
        }

        // Broadcast to everyone in the room (including the sender)
        io.to(salaId).emit('receber_mensagem', { 
            ...data, 
            usuario: nome || "Usuário", 
            timestamp: new Date() 
        });
        
        if (nome !== "IA Inteligente" && !activeSessions[salaId]) {
            AiService.processChat(salaId, mensagem, io);
        }
    });

    socket.on('disconnect', () => {
        logger.info(`Client disconnected: ${socket.id}`);
    });
});

/**
 * --- INICIALIZAÇÃO DO BANCO ---
 */
async function initDB() {
    if (!pool) {
        logger.warn("⚠️ DATABASE_URL not defined. Using in-memory mode for chat (no persistence).");
        return;
    }
    
    try {
        await query(`
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

        // Admin Master setup
        const adminEmail = (process.env.ADMIN_EMAIL || "admin").toLowerCase().trim();
        const adminPass = process.env.ADMIN_PASSWORD || "admin";
        const hash = await bcrypt.hash(adminPass, 10);
        
        await query(`
            INSERT INTO usuarios (nome, email, senha, ativo, role) 
            VALUES ('Administrador Master', $1, $2, 1, 'master') 
            ON CONFLICT (email) DO UPDATE SET role = 'master';
        `, [adminEmail, hash]);

        logger.info("✔️ Database initialized and stable.");
    } catch (err) {
        logger.error("❌ Critical database failure:", err);
    }
}

/**
 * --- ERROR HANDLING ---
 */
app.use(errorHandler);

/**
 * --- BOOTSTRAP ---
 */
const PORT = process.env.PORT || 10000;
initDB().then(() => {
    server.listen(PORT, "0.0.0.0", () => {
        logger.info(`🚀 Gateway SUS Professional active on port ${PORT}`);
        
        setInterval(() => {
            http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {}).on('error', () => {});
        }, 9 * 60 * 1000);
    });
});