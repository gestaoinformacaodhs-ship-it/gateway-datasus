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

const app = express();
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.static('public'));
app.set('trust proxy', 1);

app.use('/api', apiRoutes);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    maxHttpBufferSize: 1e7,
    transports: ['websocket', 'polling']
});

// State Management
const attendants = {}; // socketId -> { nome, rooms: [] }
const roomAssignments = {}; // salaId -> { attendantSocketId, attendantName, userName }
const userWaitList = new Set(); // salaId (users waiting for support)

const BOT_NAME = "Assistente Virtual";

io.on('connection', (socket) => {
    logger.info(`New connection: ${socket.id}`);

    // Admin/Attendant joins
    socket.on('admin_entrar', (data) => {
        socket.join('admins');
        attendants[socket.id] = { nome: data.nome, rooms: [] };
        logger.info(`Attendant online: ${data.nome}`);
        
        // Send current room assignments to the new admin
        socket.emit('lista_usuarios_ocupados', roomAssignments);
    });

    socket.on('entrar_na_sala', async (salaId) => {
        if (!salaId) return;
        socket.join(salaId);
        
        try {
            const hist = await query(
                "SELECT usuario, texto, arquivo, tipo_arquivo as tipo, timestamp FROM mensagens_suporte WHERE sala_id = $1 ORDER BY timestamp ASC LIMIT 50", 
                [salaId]
            );
            socket.emit('historico_mensagens', hist.rows);
        } catch (err) {
            if (!err.message.includes('Database')) logger.error('History error:', err);
        }
    });

    // Event for admin to "take" a chat
    socket.on('assumir_chamado', (data) => {
        const { salaId, nomeAtendente, nomeUsuario } = data;
        
        if (roomAssignments[salaId]) {
            return socket.emit('erro_chat', { mensagem: `Este chamado já está sendo atendido por ${roomAssignments[salaId].attendantName}` });
        }

        roomAssignments[salaId] = { 
            attendantSocketId: socket.id, 
            attendantName: nomeAtendente,
            userName: nomeUsuario
        };
        
        if (attendants[socket.id]) attendants[socket.id].rooms.push(salaId);
        userWaitList.delete(salaId);

        // Notify the user they are being attended
        io.to(salaId).emit('receber_mensagem', {
            usuario: BOT_NAME,
            texto: `Olá! O atendente ${nomeAtendente} assumiu seu chamado e já vai falar com você.`,
            timestamp: new Date(),
            isBot: true
        });

        // Sync with all admins
        io.emit('usuario_ocupado', { 
            salaId, 
            nomeAtendente, 
            atendenteSocketId: socket.id 
        });

        logger.info(`Attendant ${nomeAtendente} took chat ${salaId}`);
    });

    socket.on('enviar_mensagem', async (data) => {
        const { mensagem, salaId, nome, isAdmin } = data;
        if (!salaId || (!mensagem && !data.arquivo)) return;

        // If it's a user message and no one is attending yet
        if (!isAdmin && nome !== BOT_NAME && !roomAssignments[salaId]) {
            if (!userWaitList.has(salaId)) {
                userWaitList.add(salaId);
                // Initial Bot Response
                setTimeout(() => {
                    io.to(salaId).emit('receber_mensagem', {
                        usuario: BOT_NAME,
                        texto: `Olá ${nome || 'Usuário'}! Recebemos sua mensagem. Um de nossos atendentes entrará em contato em breve. Por favor, aguarde.`,
                        timestamp: new Date(),
                        isBot: true
                    });
                }, 1000);
            }
        }

        try {
            await query(
                "INSERT INTO mensagens_suporte (sala_id, usuario, texto, arquivo, tipo_arquivo) VALUES ($1, $2, $3, $4, $5)", 
                [salaId, nome || "Usuário", mensagem || null, data.arquivo || null, data.tipo_arquivo || null]
            );
        } catch (err) {}

        const msgPayload = { ...data, usuario: nome || "Usuário", timestamp: new Date() };
        
        io.to(salaId).emit('receber_mensagem', msgPayload);
        
        // Notify admins if user sent a message
        if (!isAdmin) {
            io.to('admins').emit('receber_mensagem', msgPayload);
        }
    });

    socket.on('encerrar_chamado', async (salaId) => {
        const assignment = roomAssignments[salaId];
        
        // 1. Clear database messages for this room
        try {
            await query("DELETE FROM mensagens_suporte WHERE sala_id = $1", [salaId]);
        } catch (err) {
            logger.error('Error clearing chat DB:', err);
        }

        // 2. Notify user and admin to clear UI
        io.to(salaId).emit('limpar_chat_ui', { salaId });
        
        // 3. Notify all admins that the user is free and chat ended
        io.emit('chamado_encerrado', { salaId });

        // 4. Cleanup state
        if (assignment && attendants[assignment.attendantSocketId]) {
            attendants[assignment.attendantSocketId].rooms = attendants[assignment.attendantSocketId].rooms.filter(r => r !== salaId);
        }
        delete roomAssignments[salaId];
        userWaitList.delete(salaId);

        logger.info(`Chat ${salaId} ended and cleared.`);
    });

    socket.on('disconnect', () => {
        if (attendants[socket.id]) {
            const admin = attendants[socket.id];
            admin.rooms.forEach(salaId => {
                delete roomAssignments[salaId];
                io.emit('usuario_livre', { salaId });
            });
            delete attendants[socket.id];
            logger.info(`Attendant disconnected: ${admin.nome}`);
        }
    });
});

async function initDB() {
    if (!pool) return;
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL, senha TEXT NOT NULL,
                ativo INTEGER DEFAULT 1, role TEXT DEFAULT 'user', reset_token TEXT, reset_expiracao TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS mensagens_suporte (
                id SERIAL PRIMARY KEY, sala_id TEXT NOT NULL, usuario TEXT NOT NULL, texto TEXT,
                arquivo TEXT, tipo_arquivo TEXT, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        const adminEmail = (process.env.ADMIN_EMAIL || "admin").toLowerCase().trim();
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || "admin", 10);
        await query(`
            INSERT INTO usuarios (nome, email, senha, ativo, role) 
            VALUES ('Administrador Master', $1, $2, 1, 'master') 
            ON CONFLICT (email) DO UPDATE SET role = 'master';
        `, [adminEmail, hash]);
        logger.info("✔️ DB Stable.");
    } catch (err) { logger.error("DB Error:", err); }
}

app.use(errorHandler);

const PORT = process.env.PORT || 10000;
initDB().then(() => {
    server.listen(PORT, "0.0.0.0", () => {
        logger.info(`🚀 Gateway SUS Queue System active on port ${PORT}`);
        setInterval(() => { http.get(`http://127.0.0.1:${PORT}/api/health`, () => {}).on('error', () => {}); }, 9 * 60 * 1000);
    });
});