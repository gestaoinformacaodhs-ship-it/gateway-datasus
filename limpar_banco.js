const path = require('path');
// Força o carregamento do .env usando o caminho absoluto da pasta do script
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { Pool } = require('pg');

async function limparUsuariosAntigos() {
    console.log("📂 Local do script:", __dirname);
    console.log("🔍 Procurando arquivo .env em:", path.resolve(__dirname, '.env'));

    // 1. Verificação da Variável de Ambiente
    if (!process.env.DATABASE_URL) {
        console.error("\n❌ ERRO: DATABASE_URL não encontrada!");
        console.log("--------------------------------------------------");
        console.log("DICAS DE RESOLUÇÃO:");
        console.log("1. Verifique se o arquivo se chama exatamente .env");
        console.log("2. Verifique se ele está na pasta: " + __dirname);
        console.log("3. Abra o .env e veja se está assim: DATABASE_URL=postgres://...");
        console.log("--------------------------------------------------");
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000,
    });

    console.log("🧹 Iniciando limpeza do banco de dados...");
    
    try {
        const client = await pool.connect();
        console.log("✔️ Conexão estabelecida com sucesso!");

        // 2. Execução das queries
        console.log("⏳ Removendo dados...");
        
        await client.query('DELETE FROM tokens');
        console.log("- Tabela 'tokens' limpa.");

        await client.query('DELETE FROM usuarios');
        console.log("- Tabela 'usuarios' limpa.");

        try {
            await client.query("ALTER SEQUENCE IF EXISTS usuarios_id_seq RESTART WITH 1");
            console.log("- Contador de IDs (auto-incremento) resetado.");
        } catch (e) {
            console.log("⚠️ Nota: Não foi possível resetar a sequência de IDs (comum em algumas versões do Postgres).");
        }

        client.release();
        console.log("\n✅ BANCO DE DADOS LIMPO COM SUCESSO!");
        console.log("Agora você pode fazer novos cadastros sem erros de e-mail duplicado.");

    } catch (err) {
        console.error("\n❌ ERRO DURANTE A OPERAÇÃO:");
        console.error("Mensagem:", err.message);
        
        if (err.code === 'ECONNREFUSED') {
            console.log("\n💡 DICA TÉCNICA:");
            console.log("A conexão foi recusada. Se você estiver em uma rede de empresa, a porta 5432 pode estar bloqueada.");
            console.log("Tente usar a 'Transaction Connection String' (porta 6543) do painel do Supabase.");
        }
    } finally {
        await pool.end();
    }
}

limparUsuariosAntigos();