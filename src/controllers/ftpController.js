const FtpService = require('../services/ftpService');
const logger = require('../config/logger');
const { PassThrough } = require('stream');

class FtpController {
    static async list(req, res, next) {
        const { sistema } = req.params;
        try {
            const files = await FtpService.listFiles(sistema);
            res.json({ success: true, data: files });
        } catch (err) {
            next(err);
        }
    }

    static async download(req, res, next) {
        const { sistema, arquivo } = req.params;
        try {
            res.setHeader('Content-Disposition', `attachment; filename="${arquivo}"`);
            const pt = new PassThrough();
            pt.pipe(res);
            
            await FtpService.downloadFile(sistema, arquivo, pt);
            logger.info(`Download completed: ${arquivo} (${sistema})`);
        } catch (err) {
            if (!res.headersSent) {
                next(err);
            } else {
                logger.error(`Error during streaming download: ${arquivo}`, err);
                res.end();
            }
        }
    }
}

module.exports = FtpController;
