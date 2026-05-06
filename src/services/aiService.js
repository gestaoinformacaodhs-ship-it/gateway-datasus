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
            // Using a very stable initialization for Node.js
            const genAI = new GoogleGenerativeAI(key);
            
            // Try gemini-1.5-flash first with v1 version
            let model;
            try {
                model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }, { apiVersion: "v1" });
            } catch (e) {
                model = genAI.getGenerativeModel({ model: "gemini-pro" }, { apiVersion: "v1" });
            }
            
            const prompt = `Você é o suporte do Gateway DATASUS. Responda em português, de forma útil e curta. Pergunta: "${mensagemUsuario}"`;
            
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const resposta = response.text();
            
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
                    // Silencioso
                }

                io.to(salaId).emit('receber_mensagem', msg);
                // Também avisa os admins da resposta da IA
                io.to('admins').emit('receber_mensagem', msg);
            }
        } catch (err) {
            logger.error("IA Gemini Error Details:", {
                message: err.message,
                status: err.status,
                statusText: err.statusText
            });

            // Final attempt with gemini-pro if flash failed
            if (err.message.includes('not found') || err.message.includes('404')) {
                try {
                    const genAI = new GoogleGenerativeAI(key);
                    const modelPro = genAI.getGenerativeModel({ model: "gemini-pro" }, { apiVersion: "v1" });
                    const result = await modelPro.generateContent(`Responda curto e em português: ${mensagemUsuario}`);
                    const response = await result.response;
                    const text = response.text();
                    if (text) {
                        const msg = { usuario: "IA Inteligente", texto: text, salaId, timestamp: new Date(), isAI: true };
                        io.to(salaId).emit('receber_mensagem', msg);
                        io.to('admins').emit('receber_mensagem', msg);
                    }
                } catch (proErr) {
                    logger.error("All AI Models failed (404). Please check if Generative Language API is enabled for this API Key.");
                }
            }
        }
    }
}

module.exports = AiService;
