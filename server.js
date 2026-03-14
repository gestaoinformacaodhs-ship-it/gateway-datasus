const express = require('express');
const ftp = require("basic-ftp");
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { PassThrough } = require('stream');
const crypto = require('crypto');
const SibApiV3Sdk = require('@getbrevo/brevo');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// --- CONFIGURAÇÃO BREVO API (SINTAXE ATUALIZADA) ---
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// --- BANCO DE DADOS ---
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("❌ Erro ao abrir banco de dados:", err);
    else {
        db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, email TEXT UNIQUE, senha TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS tokens (email TEXT, token TEXT PRIMARY KEY, expiracao DATETIME)`, 
        () => console.log("✔️ Banco de Dados pronto e tabelas verificadas."));
    }
});

const pastasFTP = { 'BPA': '/siasus/BPA', 'SIA': '/siasus/SIA', 'RAAS': '/siasus/RAAS', 'FPO': '/siasus/FPO' };

// --- FUNÇÃO DE ENVIO VIA API BREVO ---
async function enviarEmailReal(emailDestino, link) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

    sendSmtpEmail.subject = "Recuperação de Senha - Gateway SUS";
    sendSmtpEmail.htmlContent = `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
            <h2 style="color: #3b82f6;">Recuperação de Senha</h2>
            <p>Você solicitou a alteração de senha no sistema Gateway SUS.</p>
            <p>Clique no botão abaixo para definir sua nova senha:</p>
            <div style="text-align: center; margin: 30px 0;">
                <a href="${link}" style="background-color: #3b82f6; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">CRIAR NOVA SENHA</a>
            </div>
            <p style="font-size: 0.8rem; color: #666;">Se o botão não funcionar, copie este link: <br> ${link}</p>
        </div>`;
    
    sendSmtpEmail.sender = { "name": "Gateway SUS", "email": "gestaoinformacaodhs@gmail.com" };
    sendSmtpEmail.to = [{ "email": emailDestino }];

    try {
        await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log("✅ E-mail de recuperação enviado com sucesso para:", emailDestino);
    } catch (error) {
        console.error("❌ Erro na API do Brevo:", error.response ? error.response.body : error.message);
    }
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
        if (err || !row) return res.status(401).json({ error: "E-mail ou senha incorretos." });
        res.json({ user: row.nome });
    });
});

app.post('/api/forgot-password', (req, res) => {
    const { email } = req.body;
    db.get(`SELECT email FROM usuarios WHERE email = ?`, [email], async (err, user) => {
        if (err || !user) return res.status(404).json({ error: "Este e-mail não está cadastrado." });

        const token = crypto.randomBytes(20).toString('hex');
        const expiracao = new Date(Date.now() + 3600000).toISOString(); 

        db.run(`INSERT OR REPLACE INTO tokens (email, token, expiracao) VALUES (?, ?, ?)`, [email, token, expiracao], async (err) => {
            if (err) return res.status(500).json({ error: "Erro interno ao gerar token." });

            const protocol = req.headers['x-forwarded-proto'] || 'http';
            const link = `${protocol}://${req.get('host')}/reset-password.html?token=${token}`;
            
            console.log(`🔗 Link gerado: ${link}`);

            // Envia o e-mail real
            enviarEmailReal(email, link);

            res.json({ message: "Link de recuperação enviado para o seu e-mail!" });
        });
    });
});

app.post('/api/reset-password', (req, res) => {
    const { token, novaSenha } = req.body;
    const query = `SELECT email FROM tokens WHERE token = ? AND expiracao > datetime('now')`;

    db.get(query, [token], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "O link de recuperação é inválido ou já expirou." });
        db.serialize(() => {
            db.run(`UPDATE usuarios SET senha = ? WHERE email = ?`, [novaSenha, row.email]);
            db.run(`DELETE FROM tokens WHERE token = ?`, [token]);
            res.json({ message: "Sua senha foi atualizada com sucesso!" });
        });
    });
});

// --- ROTAS FTP (DATASUS) ---

app.get('/api/list/:sistema', async (req, res) => {
    const sistema = req.params.sistema.toUpperCase();
    if (!pastasFTP[sistema]) return res.status(400).json({ error: "Sistema inválido" });

    const client = new ftp.Client();
    try {
        await client.access({ host: "arpoador.datasus.gov.br", user: "anonymous", password: "guest" });
        await client.cd(pastasFTP[sistema]);
        const list = await client.list();
        res.json(list.filter(f => f.isFile).map(f => ({ 
            name: f.name, 
            size: (f.size / 1024 / 1024).toFixed(2) + " MB" 
        })));
    } catch (err) { 
        res.status(500).json({ error: "Erro ao conectar ao FTP do DATASUS." }); 
    } finally { 
        client.close(); 
    }
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
    } catch (err) { 
        res.status(500).send("Erro ao processar o download do arquivo."); 
    } finally { 
        client.close(); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor Gateway DATASUS rodando com sucesso na porta ${PORT}`));