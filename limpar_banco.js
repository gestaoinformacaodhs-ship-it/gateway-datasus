require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function limparUsuariosAntigos() {
    console.log("🧹 Iniciando limpeza do banco de dados...");
    
    try {
        // Testar conexão primeiro
        await pool.query('SELECT NOW()');
        console.log("✔️ Conexão com o banco estabelecida.");

        // 1. Limpa a tabela de tokens
        await pool.query('DELETE FROM tokens');
        console.log("- Tabela 'tokens' limpa.");

        // 2. Remove todos os usuários
        await pool.query('DELETE FROM usuarios');
        console.log("- Tabela 'usuarios' limpa.");

        // 3. Resetar o ID (Usando um comando que ignora se a sequence tiver nome diferente)
        try {
            await pool.query("ALTER SEQUENCE IF EXISTS usuarios_id_seq RESTART WITH 1");
            console.log("- Contador de IDs resetado.");
        } catch (seqErr) {
            console.log("⚠️ Não foi possível resetar a sequence (isso não impede o funcionamento).");
        }

        console.log("\n✅ Tudo pronto! O banco está limpo para novos testes.");
    } catch (err) {
        console.error("\n❌ ERRO DETALHADO:");
        console.error("Código:", err.code);
        console.error("Mensagem:", err.message);
        console.error("Dica:", err.hint || "Sem dicas adicionais.");
    } finally {
        await pool.end();
    }
}

limparUsuariosAntigos();