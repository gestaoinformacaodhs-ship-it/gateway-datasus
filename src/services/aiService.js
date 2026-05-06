const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require('../config/logger');
const { query } = require('../config/database');

class AiService {
    static async processChat(salaId, mensagemUsuario, io) {
        const key = process.env.GOOGLE_API_KEY?.replace(/['"\s]/g, '');
        if (!key) {
            logger.warn('GOOGLE_API_KEY missing, AI chat disabled.');
            return;
        }

        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `Você é o suporte do Gateway DATASUS. Responda em português, de forma útil e curta. Pergunta: "${mensagemUsuario}"`;
            
            const result = await model.generateContent(prompt);
            const resposta = result.response.text();
            
            if (resposta) {
                const msg = { 
                    usuario: "IA Inteligente", 
                    texto: resposta, 
                    salaId, 
                    timestamp: new Date(), 
                    isAI: true 
                };

                try {
                    await query("INSERT INTO mensagens_suporte (sala_id, usuario, texto) VALUES ($1, $2, $3)", 
                    [salaId, "IA Inteligente", resposta]);
                } catch (dbErr) {
                    logger.error('Error saving AI message to DB:', dbErr);
                }

                io.to(salaId).emit('receber_mensagem', msg);
            }
        } catch (err) {
            logger.error("IA Gemini Error:", err.message);
        }
    }
}

module.exports = AiService;
