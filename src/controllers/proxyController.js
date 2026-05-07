const ProxyService = require('../services/proxyService');
const logger = require('../config/logger');

class ProxyController {
    static async handleProxy(req, res, next) {
        const target = req.query.url;
        if (!target) return res.status(400).json({ success: false, error: "URL missing" });

        const isSihd = target.includes('sihd');
        const domain = isSihd ? 'sihd.datasus.gov.br' : 'sia.datasus.gov.br';
        const proxyRoute = isSihd ? '/api/sihd-proxy' : '/api/sia-proxy';

        // Build full absolute URL — target may be a relative path like /principal/index.php
        let fullUrl = target;
        if (target.startsWith('/') || !target.startsWith('http')) {
            fullUrl = `http://${domain}${target.startsWith('/') ? '' : '/'}${target}`;
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
            const processedHtml = ProxyService.injectCustomAssets(html, proxyRoute, target);
            
            res.send(processedHtml);
        } catch (err) {
            logger.error(`Proxy Error for ${target}:`, err);
            res.status(500).send("Proxy error: " + err.message);
        }
    }
}

module.exports = ProxyController;
