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

// --- COMPRESSÃO E PARSER ---
app.use(compression()); 
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

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
    console.log("✔️ API Brevo configurada com sucesso.");
}

// --- CONFIGURAÇÃO BANCO DE DADOS (PostgreSQL) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 15,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
    console.error('❌ Erro inesperado no cliente PostgreSQL:', err.message);
});

async function initDB() {
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id SERIAL PRIMARY KEY,
                nome TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                senha TEXT NOT NULL,
                ativo INTEGER DEFAULT 1, 
                reset_token TEXT,
                reset_expiracao TIMESTAMP
            );
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
        client.release();
        console.log("✔️ Banco de Dados pronto.");
    } catch (err) {
        console.error("❌ Erro na criação das tabelas ou conexão:", err.message);
    }
}
initDB();

// --- LÓGICA DO CHAT (SOCKET.IO) ---
io.on('connection', (socket) => {
    
    socket.on('admin_entrar', () => {
        socket.join('admin_room');
        console.log("🛠️ Admin entrou no monitoramento.");
    });
    
    socket.on('entrar_na_sala', async (salaId) => {
        if (!salaId) return;
        
        const salasAtuais = Array.from(socket.rooms);
        salasAtuais.forEach(sala => {
            if (sala !== socket.id && sala !== 'admin_room') socket.leave(sala);
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
            
            if (nomeUsuario !== "Suporte Arpoador") {
                io.to('admin_room').emit('receber_mensagem', msgData);
            }
        } catch (err) { 
            console.error("Erro ao enviar mensagem:", err.message); 
        }
    });

    socket.on('encerrar_chamado', async (salaId) => {
        if (!salaId) return;
        try {
            await pool.query("DELETE FROM mensagens_suporte WHERE sala_id = $1", [salaId]);
            io.to(salaId).emit('chamado_encerrado', { salaId });
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
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/registrar', async (req, res) => {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ error: "Campos obrigatórios ausentes." });

    try {
        const hash = await bcrypt.hash(senha, 10);
        await pool.query(
            "INSERT INTO usuarios (nome, email, senha, ativo) VALUES ($1, $2, $3, 1)",
            [nome, email.toLowerCase().trim(), hash]
        );
        res.json({ message: "Conta criada com sucesso!" });
    } catch (err) {
        res.status(400).json({ error: "E-mail já cadastrado ou erro nos dados." });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: "E-mail e senha são obrigatórios." });

    try {
        const result = await pool.query(`SELECT nome, email, senha, ativo FROM usuarios WHERE email = $1`, [email.toLowerCase().trim()]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(senha, user.senha))) {
            return res.status(401).json({ error: "Credenciais inválidas." });
        }
        
        res.json({ user: user.nome, email: user.email });
    } catch (err) { 
        res.status(500).json({ error: "Erro no servidor." }); 
    }
});

app.post('/api/update-profile', async (req, res) => {
    const { nome, email, novaSenha } = req.body;
    try {
        const emailFormatado = email.toLowerCase().trim();
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

app.post('/api/delete-account', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Identificação do usuário ausente." });

    const client = await pool.connect();
    try {
        await client.query('BEGIN'); 

        const emailFormatado = email.toLowerCase().trim();
        await client.query("DELETE FROM mensagens_suporte WHERE usuario = $1 OR sala_id = $1", [emailFormatado]);
        const result = await client.query("DELETE FROM usuarios WHERE email = $1", [emailFormatado]);

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

// --- PROXY SIASUS PARA INTEGRAÇÃO NATIVA MESTRE ---
async function handleSiaProxy(req, res, targetUrl) {
    if (!targetUrl) return res.status(400).send("No URL provided");
    if (!targetUrl.startsWith('http')) {
        targetUrl = 'http://sia.datasus.gov.br' + (targetUrl.startsWith('/') ? '' : '/') + targetUrl;
    }

    try {
        const fetchMethod = global.fetch; // Node 18+ nativo
        const baseDomain = targetUrl.includes('sihd.datasus') ? 'sihd.datasus.gov.br' : 'sia.datasus.gov.br';

        let options = {
            method: req.method,
            redirect: 'follow',
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': `http://${baseDomain}/principal/index.php`,
                'Host': baseDomain,
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
            return res.send(buffer);
        }

        let html = buffer.toString('latin1');
        
        // TRATAMENTO DE HTML
        let modifiedHtml = html.replace(/<head>/i, `<head><base href="${finalUrl}">
        <style>
            body, html { background-color: #111827 !important; color: #cbd5e1 !important; font-family: 'Inter', sans-serif !important; margin: 0; padding: 0; overflow: auto; }
            /* Esconder todas as scrollbars mantendo a rolagem funcional */
            * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
            *::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
            table, td, th { background-color: #1e293b !important; color: #cbd5e1 !important; border-color: #334155 !important; }
            a { color: #3b82f6 !important; text-decoration: none; font-weight: bold; }
            a:hover { color: #60a5fa !important; text-decoration: underline; }
            .conteudo, .tabela1, .tabela2, .box, div, span, p, font { background: transparent !important; border-color: #334155 !important; color: #cbd5e1 !important; }
            img[src*="topo_sia"], map, area, table[width="766"] > tbody > tr:first-child, table[width="766"] > tbody > tr:nth-child(2), td[background*="menu_fundo"], div[align="center"] > img, img[src*="menu"], #barra_submenu, .item_submenu, .item_submenu2, .ms_caixa_topo_meio, .menu { display: none !important; }
            
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

        // Correção massiva também para scripts (src), forms (action) e hrefs!
        modifiedHtml = modifiedHtml.replace(/(href|src|action)=["'](?!javascript|#|mailto|data:)(([^"']+))["']/gi, (match, type, p1) => {
            const lowerP1 = p1.toLowerCase();
            const proxyApiRoute = targetUrl.includes('sihd.datasus') ? '/api/sihd-proxy' : '/api/sia-proxy';

            // Links FTP: redirecionar para rota de download nativa (sem abrir nova aba)
            if (p1.startsWith('ftp://')) {
                return `href="/api/ftp-download?url=${encodeURIComponent(p1)}"`;
            }
            if (type === 'href' && (lowerP1.endsWith('.zip') || lowerP1.endsWith('.exe') || lowerP1.endsWith('.pdf') || lowerP1.endsWith('.doc') || lowerP1.endsWith('.xls'))) {
                if (p1.startsWith('http')) return `href="${p1}" target="_blank"`;
                return `href="http://${baseDomain}/${p1.replace(/^\//, '')}" target="_blank"`;
            }
            if (p1.startsWith(`http://${baseDomain}`) || p1.startsWith('/')) {
                return `${type}="${proxyApiRoute}?url=${encodeURIComponent(p1)}"`;
            }
            if (!p1.startsWith('http')) {
                let baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
                return `${type}="${proxyApiRoute}?url=${encodeURIComponent(baseUrl + p1)}"`;
            }
            return match; 
        });

        res.send(modifiedHtml);
    } catch (e) {
        console.error("Proxy error: ", e);
        res.status(500).send(`<div style="color:white; font-family:sans-serif; text-align:center; padding: 20px;">
            <h2>Erro de Integração</h2><p>Falha ao conectar no DATASUS: ${e.message}</p></div>`);
    }
}

app.all('/api/sia-proxy', (req, res) => handleSiaProxy(req, res, req.query.url));
app.all('/api/sihd-proxy', (req, res) => handleSiaProxy(req, res, req.query.url));

// --- INTERCEPTAÇÃO TRANSPARENTE DE AJAX E ASSETS ---
const DATASUS_FOLDERS = ['/funcoes', '/imagens', '/Controler', '/remessa/Controler', '/css', '/js', '/padroes', '/versao', '/documentos', '/remessa'];
DATASUS_FOLDERS.forEach(folder => {
    app.all(`${folder}/*`, (req, res) => {
        const referer = req.headers.referer || '';
        const targetDomain = referer.includes('sihd-proxy') ? 'sihd.datasus.gov.br' : 'sia.datasus.gov.br';
        handleSiaProxy(req, res, `http://${targetDomain}${req.originalUrl}`);
    });
});

// --- DOWNLOAD DIRETO DE ARQUIVOS FTP DATASUS ---
app.get('/api/ftp-download', async (req, res) => {
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