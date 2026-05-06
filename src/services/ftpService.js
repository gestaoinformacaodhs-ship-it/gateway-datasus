const ftp = require("basic-ftp");
const logger = require('../config/logger');

class FtpService {
    static getFtpConfig(sistema) {
        const s = sistema.toUpperCase();
        const pastas = { 
            'BPA': '/siasus/BPA', 
            'SIA': '/siasus/SIA', 
            'CNES': '/cnes', 
            'SIHD': '/public/sistemas/dsweb/SIHD/Programas', 
            'CIHA': '/public/sistemas/dsweb/CIHA' 
        };
        const hosts = {
            'CNES': "ftp.datasus.gov.br",
            'SIHD': "ftp2.datasus.gov.br",
            'CIHA': "ftp2.datasus.gov.br",
            'DEFAULT': "arpoador.datasus.gov.br"
        };

        return {
            host: hosts[s] || hosts['DEFAULT'],
            path: pastas[s],
            user: "anonymous",
            password: "guest"
        };
    }

    static async listFiles(sistema) {
        const config = this.getFtpConfig(sistema);
        if (!config.path) throw new Error('Sistema inválido');

        const client = new ftp.Client(30000);
        try {
            await client.access({ host: config.host, user: config.user, password: config.password });
            await client.cd(config.path);
            const list = await client.list();
            return list.filter(f => f.isFile).map(f => ({
                name: f.name,
                size: (f.size / 1024 / 1024).toFixed(2) + " MB",
                rawDate: f.modifiedAt
            }));
        } finally {
            client.close();
        }
    }

    static async downloadFile(sistema, arquivo, outStream) {
        const config = this.getFtpConfig(sistema);
        if (!config.path) throw new Error('Sistema inválido');

        const client = new ftp.Client(60000);
        try {
            await client.access({ host: config.host, user: config.user, password: config.password });
            await client.cd(config.path);
            await client.downloadTo(outStream, arquivo);
        } finally {
            client.close();
        }
    }
}

module.exports = FtpService;
