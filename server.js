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

// --- CONFIGURAÇÃO GMAIL (SENHA DE APP) ---
const GMAIL_USER = 'gestaoinformacaodhs@gmail.com'; 
const GMAIL_PASS = 'itgh dwtt nexb sqka'; // Insira aqui os 16 dígitos gerados no Google

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: GMAIL_USER,
        pass: GMAIL_PASS
    }
});

// --- BANCO DE DADOS ---
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Erro ao abrir banco de dados:", err);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nome TEXT,
            email TEXT UNIQUE,
            senha TEXT
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS tokens (
            email TEXT,
            token TEXT PRIMARY KEY,
            expiracao DATETIME
        )`, () => console.log("✔️ Banco de Dados e Tabela de Tokens prontos."));
    }
});

const pastasFTP = {
    'BPA': '/siasus/BPA',
    'SIA': '/siasus/SIA',
    'RAAS': '/siasus/RAAS',
    'FPO': '/siasus/FPO'
};

// --- FUNÇÃO DE ENVIO DE E-MAIL REAL ---
async function enviarEmailReal(emailDestino, link) {
    const mailOptions = {
        from: `"Gateway DATASUS" <${GMAIL_USER}>`,
        to: emailDestino,
        subject: "Recuperação de Senha - Gateway SUS",
        html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px;">
                <h2 style="color: #3b82f6;">Recuperação de Senha</h2>
                <p>Você solicitou a alteração de senha no sistema Gateway SUS.</p>
                <p>Clique no botão abaixo para definir uma nova senha. Este link é válido por 1 hora.</p>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="${link}" style="background-color: #3b82f6; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">CRIAR NOVA SENHA</a>
                </div>
                <p style="font-size: 0.8rem; color: #666;">Se você não solicitou esta alteração, ignore este e-mail.</p>
            </div>
        `
    };

    return transporter.sendMail(mailOptions);
}

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/register', (req, res) => {
    const { nome, email, senha } = req.body;
    db.run(`INSERT INTO usuarios (nome, email, senha) VALUES (?, ?, ?)`, [nome, email, senha], (err) => {
        if (err) return res.status(400).json({ error: "E-mail já cadastrado." });
        res.status(201).json({ message: "Usuário criado com sucesso" });
    });
});

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    db.get(`SELECT nome FROM usuarios WHERE email = ? AND senha = ?`, [email, senha], (err, row) => {
        if (err || !row) return res.status(401).json({ error: "Credenciais inválidas." });
        res.json({ user: row.nome });
    });
});

// --- SISTEMA DE RECUPERAÇÃO DE SENHA ---

app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;
    
    db.get(`SELECT email FROM usuarios WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(404).json({ error: "E-mail não encontrado." });

        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000).toISOString(); 

        db.run(`INSERT OR REPLACE INTO tokens (email, token, expiracao) VALUES (?, ?, ?)`, 
            [email, token, expiracao], async (err) => {
                if (err) return res.status(500).json({ error: "Erro no servidor." });

                const link = `http://localhost:3000/reset-password.html?token=${token}`;
                
                try {
                    await enviarEmailReal(email, link);
                    console.log(`📧 E-mail de recuperação enviado para: ${email}`);
                    res.json({ message: "E-mail enviado com sucesso!" });
                } catch (mailErr) {
                    console.error("❌ Erro SMTP:", mailErr);
                    res.status(500).json({ error: "Erro ao enviar e-mail. Verifique a Senha de App." });
                }
        });
    });
});

app.post('/api/reset-password', (req, res) => {
    const { token, novaSenha } = req.body;

    // Usamos datetime('now') para garantir que a comparação seja feita no fuso horário correto do banco
    const query = `
        SELECT email FROM tokens 
        WHERE token = ? AND expiracao > datetime('now', '-3 hours')
    `;

    db.get(query, [token], (err, row) => {
        if (err) {
            console.error("Erro ao consultar token:", err);
            return res.status(500).json({ error: "Erro interno no servidor." });
        }
        
        if (!row) {
            return res.status(400).json({ error: "Link inválido ou expirado." });
        }

        db.serialize(() => {
            // 1. Atualiza a senha do usuário
            db.run(`UPDATE usuarios SET senha = ? WHERE email = ?`, [novaSenha, row.email]);
            // 2. Remove o token para ele não ser usado de novo
            db.run(`DELETE FROM tokens WHERE token = ?`, [token]);
            
            console.log(`✔️ Senha atualizada para o usuário: ${row.email}`);
            res.json({ message: "Senha atualizada com sucesso!" });
        });
    });
});

// --- ROTAS FTP (LISTAGEM E DOWNLOAD) ---

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    const client = new ftp.Client();
    client.ftp.timeout = 60000;

    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        const pasta = pastasFTP[sistema];
        if (!pasta) throw new Error("Sistema não mapeado.");
        await client.cd(pasta);
        const list = await client.list();
        const arquivos = list.filter(f => f.isFile).map(f => ({
            name: f.name,
            size: (f.size / 1024 / 1024).toFixed(2) + " MB"
        }));
        res.json(arquivos);
    } catch (err) {
        res.status(500).json({ error: "Erro ao conectar com DATASUS." });
    } finally {
        client.close();
    }
});

app.get('/api/download/:sistema/:arquivo', async (req, res) => {
    const { sistema, arquivo } = req.params;
    const client = new ftp.Client();
    client.ftp.timeout = 0; 

    try {
        await client.access({ 
            host: "arpoador.datasus.gov.br", 
            user: "anonymous", 
            password: "guest",
            secure: false
        });
        client.ftp.ipFamily = 4;
        const pasta = pastasFTP[sistema.toUpperCase()];
        await client.cd(pasta);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(arquivo)}"`);

        const tunnel = new PassThrough();
        tunnel.pipe(res);

        await client.send("TYPE I");
        await client.downloadTo(tunnel, arquivo);
    } catch (err) {
        if (!res.headersSent) res.status(500).send("Erro no download.");
        else res.end();
    } finally {
        client.close();
    }
});

app.listen(3000, () => {
    console.log("\x1b[32m%s\x1b[0m", "-----------------------------------------");
    console.log("\x1b[32m%s\x1b[0m", "    GATEWAY DATASUS - ONLINE (PORTA 3000)");
    console.log("\x1b[32m%s\x1b[0m", "-----------------------------------------");
});