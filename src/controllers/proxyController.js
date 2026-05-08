const ProxyService = require('../services/proxyService');
const logger = require('../config/logger');
const ftp = require('basic-ftp');
const { PassThrough } = require('stream');


class ProxyController {
    static async handleProxy(req, res, next) {
        const target = req.query.url;
        if (!target) return res.status(400).json({ success: false, error: "URL missing" });

        const isSihd = target.includes('sihd');
        const isMsBbs = target.includes('msbbs');
        
        let domain = isSihd ? 'sihd.datasus.gov.br' : 'sia.datasus.gov.br';
        if (isMsBbs) domain = 'msbbs.datasus.gov.br';

        const proxyRoute = isSihd ? '/api/sihd-proxy' : '/api/sia-proxy';

        // Build full absolute URL
        let fullUrl = target;
        if (target.startsWith('/') || !target.startsWith('http')) {
            fullUrl = `http://${domain}${target.startsWith('/') ? '' : '/'}${target}`;
        } else {
            // If it's a full URL, extract the actual domain for headers
            try {
                const urlObj = new URL(target);
                domain = urlObj.hostname;
            } catch (e) {}
        }

        try {
            const options = {
                method: req.method,
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 
                    'Referer': `http://${domain}/`, 
                    'Cookie': req.headers.cookie || '' 
                }
            };

            if (req.method !== 'GET') {
                options.body = new URLSearchParams(req.body).toString();
                options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            }

            const response = await fetch(fullUrl, options);
            const contentType = response.headers.get('content-type') || '';
            
            // Forward cookies
            if (response.headers.getSetCookie) {
                const cookies = response.headers.getSetCookie().map(c => c.replace(/domain=[^;]+/gi, ''));
                res.setHeader('Set-Cookie', cookies);
            }

            // Handle non-HTML or static resources early
            if (!contentType.includes('text/html') || ProxyService.isStaticResource(target)) {
                res.setHeader('Content-Type', contentType);
                const buffer = Buffer.from(await response.arrayBuffer());
                return res.send(buffer);
            }

            // Handle HTML injection
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            
            // Try to detect encoding or default to latin1 (common in old government sites)
            const html = buffer.toString('latin1');
            const processedHtml = ProxyService.injectCustomAssets(html, proxyRoute, fullUrl);
            
            res.send(processedHtml);
        } catch (err) {
            logger.error(`Proxy Error for ${target}:`, err);
            res.status(500).send("Proxy error: " + err.message);
        }
    }
    /**
     * Downloads a file from an FTP URL server-side and streams it to the browser.
     * This bypasses Chrome's lack of native FTP support (which delegates to Edge).
     * Usage: GET /api/ftp-proxy?url=ftp://arpoador.datasus.gov.br/siasus/fpo/FPO_Leiame.txt
     */
    static async handleFtpProxy(req, res) {
        const rawUrl = req.query.url;
        if (!rawUrl || !rawUrl.startsWith('ftp://')) {
            return res.status(400).json({ success: false, error: 'FTP URL inválida ou ausente.' });
        }

        let ftpUrl;
        try {
            ftpUrl = new URL(rawUrl);
        } catch (e) {
            return res.status(400).json({ success: false, error: 'URL FTP malformada.' });
        }

        const host = ftpUrl.hostname;
        const remotePath = decodeURIComponent(ftpUrl.pathname); // e.g. /siasus/fpo/FPO_Leiame.txt
        const filename = remotePath.split('/').pop() || 'download';

        const client = new ftp.Client(60000);
        client.ftp.verbose = false;

        try {
            await client.access({ host, user: 'anonymous', password: 'guest' });

            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Type', 'application/octet-stream');

            const pt = new PassThrough();
            pt.pipe(res);

            await client.downloadTo(pt, remotePath);
            logger.info(`FTP Proxy download: ${rawUrl}`);
        } catch (err) {
            logger.error(`FTP Proxy Error for ${rawUrl}:`, err);
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: 'Erro ao baixar arquivo FTP: ' + err.message });
            } else {
                res.end();
            }
        } finally {
            client.close();
        }
    }
}

module.exports = ProxyController;
