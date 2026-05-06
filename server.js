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
const userWaitList = new Set(); 

const BOT_NAME = "Assistente Virtual";

io.on('connection', (socket) => {
    logger.info(`New connection: ${socket.id}`);

    socket.on('admin_entrar', (data) => {
        socket.join('admins');
        attendants[socket.id] = { nome: data.nome, rooms: [] };
        const assignmentsSync = {};
        for (const id in roomAssignments) {
            assignmentsSync[id] = roomAssignments[id].attendantName;
        }
        socket.emit('lista_usuarios_ocupados', assignmentsSync);
    });

    socket.on('entrar_na_sala', async (salaId) => {
        if (!salaId) return;
        
        const assignment = roomAssignments[salaId];
        const isAttendant = !!attendants[socket.id];
        
        if (isAttendant && assignment && assignment.attendantSocketId !== socket.id) {
            return socket.emit('erro_chat', { mensagem: `Acesso negado: Este chamado está sendo atendido por ${assignment.attendantName}` });
        }

        socket.join(salaId);
        
        try {
            const hist = await query(
                "SELECT usuario, texto, arquivo, tipo_arquivo as tipo, timestamp FROM mensagens_suporte WHERE sala_id = $1 ORDER BY timestamp ASC LIMIT 50", 
                [salaId]
            );
            socket.emit('historico_mensagens', hist.rows);
        } catch (err) {}
    });

    socket.on('sair_da_sala', (salaId) => {
        socket.leave(salaId);
    });

    socket.on('assumir_chamado', async (data) => {
        const { salaId, nomeAtendente, nomeUsuario } = data;
        
        if (roomAssignments[salaId]) {
            return socket.emit('erro_chat', { mensagem: `Este chamado já está sendo atendido por ${roomAssignments[salaId].attendantName}` });
        }

        roomAssignments[salaId] = { 
            attendantSocketId: socket.id, 
            attendantName: nomeAtendente,
            userName: nomeUsuario || "Usuário"
        };
        
        if (attendants[socket.id]) attendants[socket.id].rooms.push(salaId);
        userWaitList.delete(salaId);

        io.to('admins').emit('usuario_ocupado', { 
            salaId, 
            nomeAtendente: nomeAtendente, 
            atendenteSocketId: socket.id 
        });

        // Hard Ejection: Make all other admins leave this room immediately
        const sockets = await io.in('admins').fetchSockets();
        sockets.forEach(s => {
            if (s.id !== socket.id) s.leave(salaId);
        });

        socket.to('admins').emit('forçar_saida_sala', { salaId });

        io.to(salaId).emit('receber_mensagem', {
            usuario: BOT_NAME,
            texto: `O atendente ${nomeAtendente} assumiu seu chamado e está pronto para ajudar.`,
            timestamp: new Date(),
            isBot: true
        });

        logger.info(`Attendant ${nomeAtendente} took chat ${salaId}`);
    });

    socket.on('enviar_mensagem', async (data) => {
        const { mensagem, salaId, nome, isAdmin } = data;
        if (!salaId || (!mensagem && !data.arquivo)) return;

        const isAttendant = isAdmin || !!attendants[socket.id];

        // PROTECTION: Only the assigned attendant can send messages in an assigned room
        if (isAttendant && roomAssignments[salaId] && roomAssignments[salaId].attendantSocketId !== socket.id) {
            return socket.emit('erro_chat', { mensagem: "Você não é o atendente responsável por este chamado." });
        }

        const nomeFinal = sanitizarNome(nome || data.usuario || "Usuário");

        if (!isAdmin && !roomAssignments[salaId] && !userWaitList.has(salaId)) {
            userWaitList.add(salaId);
            setTimeout(() => {
                io.to(salaId).emit('receber_mensagem', {
                    usuario: BOT_NAME,
                    texto: `Olá ${nomeFinal}! Eu sou o Assistente Virtual. Como posso ajudar? Caso precise falar com um atendente humano, basta aguardar um momento.`,
                    timestamp: new Date(),
                    isBot: true
                });
            }, 800);
        }

        try {
            await query(
                "INSERT INTO mensagens_suporte (sala_id, usuario, texto, arquivo, tipo_arquivo) VALUES ($1, $2, $3, $4, $5)", 
                [salaId, nomeFinal, mensagem || null, data.arquivo || null, data.tipo_arquivo || null]
            );
        } catch (err) {}

        const msgPayload = { 
            ...data, 
            usuario: nomeFinal, 
            timestamp: new Date() 
        };
        
        io.to(salaId).emit('receber_mensagem', msgPayload);
        
        if (!isAdmin && !roomAssignments[salaId]) {
            io.to('admins').emit('receber_mensagem', msgPayload);
        }
    });

    socket.on('encerrar_chamado', async (salaId) => {
        try {
            await query("DELETE FROM mensagens_suporte WHERE sala_id = $1", [salaId]);
        } catch (err) {}

        io.to(salaId).emit('limpar_chat_ui', { salaId });
        io.to('admins').emit('remover_usuario_lista', { salaId });

        const assignment = roomAssignments[salaId];
        if (assignment && attendants[assignment.attendantSocketId]) {
            attendants[assignment.attendantSocketId].rooms = attendants[assignment.attendantSocketId].rooms.filter(r => r !== salaId);
        }
        delete roomAssignments[salaId];
        userWaitList.delete(salaId);
    });

    socket.on('obter_atendentes_online', () => {
        const list = [];
        for (const id in attendants) {
            if (id !== socket.id) {
                list.push({ id, nome: attendants[id].nome });
            }
        }
        socket.emit('lista_atendentes_online', list);
    });

    socket.on('transferir_chamado', async (data) => {
        const salaId = typeof data === 'string' ? data : data.salaId;
        const targetSocketId = data.targetSocketId;
        
        const assignment = roomAssignments[salaId];
        if (!assignment || assignment.attendantSocketId !== socket.id) return;

        // Release or Reassign
        if (targetSocketId && attendants[targetSocketId]) {
            // TARGETED TRANSFER
            const targetName = attendants[targetSocketId].nome;
            roomAssignments[salaId] = {
                attendantSocketId: targetSocketId,
                attendantName: targetName,
                userName: assignment.userName
            };
            attendants[targetSocketId].rooms.push(salaId);
            
            // Notify target specifically
            io.to(targetSocketId).emit('chamado_transferido_alerta', { 
                salaId, 
                doNome: assignment.attendantName,
                userName: assignment.userName
            });
            
            // Notify all admins about the change of ownership
            io.to('admins').emit('usuario_ocupado', { 
                salaId, 
                nomeAtendente: targetName, 
                atendenteSocketId: targetSocketId 
            });
        } else {
            // GENERAL RELEASE (Back to queue)
            delete roomAssignments[salaId];
            io.to('admins').emit('usuario_livre', { salaId });
        }

        // Cleanup original owner
        if (attendants[socket.id]) {
            attendants[socket.id].rooms = attendants[socket.id].rooms.filter(r => r !== salaId);
        }
        socket.leave(salaId);

        // Notify room
        io.to(salaId).emit('receber_mensagem', {
            usuario: BOT_NAME,
            texto: `Este atendimento foi transferido. Por favor, aguarde o novo atendente.`,
            timestamp: new Date(),
            isBot: true
        });

        logger.info(`Chat ${salaId} was transferred by ${assignment.attendantName} to ${targetSocketId ? 'Target' : 'Queue'}`);
    });

    socket.on('disconnect', () => {
        if (attendants[socket.id]) {
            const admin = attendants[socket.id];
            admin.rooms.forEach(salaId => {
                delete roomAssignments[salaId];
                io.to('admins').emit('usuario_livre', { salaId });
            });
            delete attendants[socket.id];
        }
    });
});

function sanitizarNome(nome) {
    if (!nome || String(nome).toLowerCase() === 'undefined' || String(nome).toLowerCase() === 'null') {
        return "Usuário";
    }
    return String(nome);
}

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