const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { PassThrough } = require('stream');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();

app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURAÇÃO GMAIL ---
const GMAIL_USER = process.env.GMAIL_USER || 'gestaoinformacaodhs@gmail.com'; 
const GMAIL_PASS = process.env.GMAIL_PASS || 'itgh dwtt nexb sqka'; 

const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, 
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false 
    },
    // Adicionado para evitar que a requisição fique "presa"
    connectionTimeout: 10000, 
    greetingTimeout: 10000
});

// Teste de conexão imediato ao iniciar
transporter.verify((error) => {
    if (error) console.log("❌ Erro na configuração de e-mail:", error);
    else console.log("✅ Servidor de e-mail pronto!");
});

// --- BANCO DE DADOS ---
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Erro ao abrir banco de dados:", err);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, email TEXT UNIQUE, senha TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS tokens (email TEXT, token TEXT PRIMARY KEY, expiracao DATETIME)`, 
        () => console.log("✔️ Banco de Dados pronto."));
    }
});

const pastasFTP = { 'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 'FPO': '/siasus/FPO' };

async function enviarEmailReal(emailDestino, link) {
    const mailOptions = {
        from: `"Gateway DATASUS" <${GMAIL_USER}>`,
        to: emailDestino,
        subject: "Recuperação de Senha - Gateway SUS",
        html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px;">
                <h2 style="color: #3b82f6;">Recuperação de Senha</h2>
                <p>Clique no botão abaixo para definir uma nova senha. Link válido por 1 hora.</p>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${link}" style="background-color: #3b82f6; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">CRIAR NOVA SENHA</a>
                </div>
            </div>`
    };
    return transporter.sendMail(mailOptions);
}

// --- ROTAS ---

app.post('/api/register', (req, res) => {
    const { nome, email, senha } = req.body;
    db.run(`INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)`, [nome, email, senha], (err) => {
        if (err) return res.status(400).json({ error: "E-mail já cadastrado." });
        res.status(201).json({ message: "Usuário criado" });
    });
});

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    db.get(`SELECT nome FROM usuarios WHERE email = ? AND senha = ?`, [email, senha], (err, row) => {
        if (err || !row) return res.status(401).json({ error: "Credenciais inválidas." });
        res.json({ user: row.nome });
    });
});

app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;
    db.get(`SELECT email FROM usuarios WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(404).json({ error: "E-mail não encontrado." });

        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000).toISOString(); 

        db.run(`INSERT OR REPLACE INTO tokens (email, token, expiracao) VALUES (?, ?, ?)`, [email, token, expiracao], async (err) => {
            if (err) return res.status(500).json({ error: "Erro no servidor." });

            const protocol = req.headers['x-forwarded-proto'] || 'http';
            const link = `${protocol}://${req.get('host')}/reset-password.html?token=${token}`;
            
            try {
                await enviarEmailReal(email, link);
                res.json({ message: "E-mail enviado!" });
            } catch (mailErr) {
                console.error("❌ Erro detalhado SMTP:", mailErr);
                res.status(500).json({ error: "O servidor de e-mail recusou a conexão. Verifique os logs." });
            }
        });
    });
});

app.post('/api/reset-password', (req, res) => {
    const { token, novaSenha } = req.body;
    const query = `SELECT email FROM tokens WHERE token = ? AND expiracao > datetime('now', '-3 hours')`;

    db.get(query, [token], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "Link inválido ou expirado." });
        db.serialize(() => {
            db.run(`UPDATE usuarios SET senha = ? WHERE email = ?`, [novaSenha, row.email]);
            db.run(`DELETE FROM tokens WHERE token = ?`, [token]);
            res.json({ message: "Senha atualizada!" });
        });
    });
});

// --- FTP ---
app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        res.json(list.filter(f => f.isFile).map(f => ({ name: f.name, size: (f.size / 1024 / 1024).toFixed(2) + " MB" })));
    } catch (err) { res.status(500).json({ error: "Erro FTP" }); }
    finally { client.close(); }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema.toUpperCase()]);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(arquivo)}"`);
        const tunnel = new PassThrough();
        tunnel.pipe(res);
        await client.downloadTo(tunnel, arquivo);
    } catch (err) { res.status(500).send("Erro download"); }
    finally { client.close(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});