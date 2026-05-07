const cheerio = require('cheerio');
const logger = require('../config/logger');

class ProxyService {
    /**
     * Determines if a URL points to a static resource (JS, CSS, Images, etc.)
     */
    static isStaticResource(url) {
        const staticExtensions = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|otf|pdf|zip|rar)$/i;
        return staticExtensions.test(url.split('?')[0]);
    }

    /**
     * Extracts the directory base URL from an absolute URL.
     * e.g. http://sia.datasus.gov.br/versao/versao.php → http://sia.datasus.gov.br/versao/
     */
    static getBaseDir(absoluteUrl) {
        try {
            const u = new URL(absoluteUrl);
            const pathParts = u.pathname.split('/');
            pathParts.pop(); // remove filename
            u.pathname = pathParts.join('/') + '/';
            return u.href;
        } catch (e) {
            return absoluteUrl;
        }
    }

    /**
     * Injects modern CSS and scripts into the DATASUS HTML,
     * and rewrites all internal links/assets to go through our proxy.
     * 
     * Strategy:
     *   1. Inject <base href> pointing to the DATASUS domain so ALL relative
     *      resources (images, CSS backgrounds, JS) auto-resolve without 404.
     *   2. Override <a href> navigation links to go through our proxy.
     *   3. Override <form action> to go through our proxy.
     *   4. Override FTP links to use our /api/ftp-proxy endpoint so files
     *      download directly in Chrome without needing Edge.
     * 
     * @param {string} html - Raw HTML from DATASUS server
     * @param {string} proxyRoute - e.g. /api/sia-proxy or /api/sihd-proxy
     * @param {string} targetBaseUrl - Full absolute URL of the proxied page
     */
    static injectCustomAssets(html, proxyRoute, targetBaseUrl) {
        const $ = cheerio.load(html);

        // --- Step 1: Inject <base href> to fix ALL relative resource loading ---
        // This makes imagens/btn.gif, funcoes/funcoesGerais.js, etc. 
        // resolve directly from the DATASUS server (no CORS issues for passive resources).
        const baseDir = ProxyService.getBaseDir(targetBaseUrl);
        $('head').prepend(`<base href="${baseDir}">`);

        // --- Step 2: Inject modern dark theme styles ---
        $('head').append(`
            <style id="gateway-styles">
                :root {
                    --bg-main: #0f172a;
                    --bg-card: #1e293b;
                    --text-main: #f8fafc;
                    --accent: #3b82f6;
                    --border: #334155;
                }
                body { 
                    background: var(--bg-main) !important; 
                    color: var(--text-main) !important; 
                    font-family: 'Inter', sans-serif !important;
                }
                a { color: var(--accent) !important; text-decoration: none !important; }
                a:hover { text-decoration: underline !important; }
                table { border-collapse: collapse !important; width: 100% !important; margin: 1rem 0 !important; }
                td, th { border: 1px solid var(--border) !important; padding: 12px !important; background: var(--bg-card) !important; }
                input, select, textarea { 
                    background: var(--bg-card) !important; 
                    color: var(--text-main) !important; 
                    border: 1px solid var(--border) !important; 
                    padding: 8px !important;
                    border-radius: 4px !important;
                }
                .gateway-banner {
                    background: #1e293b;
                    padding: 10px;
                    border-bottom: 2px solid #3b82f6;
                    text-align: center;
                    font-weight: bold;
                    margin-bottom: 20px;
                }
            </style>
        `);

        // --- Step 3: Banner ---
        $('body').prepend('<div class="gateway-banner">Acesso via Gateway DATASUS Profissional</div>');

        // --- Step 4: Rewrite <a href> navigation and <form action> through proxy ---
        // (Static resources like <img>, <script>, <link> are handled by <base href>)
        $('a[href], form[action]').each((i, el) => {
            const attr = el.name === 'form' ? 'action' : 'href';
            const val = $(el).attr(attr);

            if (!val || val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('data:') || val.startsWith('mailto:')) return;

            // FTP links → route through our server-side FTP proxy so Chrome can download
            if (val.startsWith('ftp://')) {
                $(el).attr(attr, `/api/ftp-proxy?url=${encodeURIComponent(val)}`);
                $(el).attr('download', '');
                return;
            }

            try {
                const absoluteUrl = new URL(val, targetBaseUrl).href;
                // Route DATASUS navigation through our proxy
                if (absoluteUrl.includes('datasus.gov.br') || absoluteUrl.includes('saude.gov.br')) {
                    // If it's a PHP page (navigation), proxy through iframe proxy
                    if (!ProxyService.isStaticResource(absoluteUrl)) {
                        $(el).attr(attr, `${proxyRoute}?url=${encodeURIComponent(absoluteUrl)}`);
                    }
                    // If it's a file link (pdf, zip, etc.) route through proxy for direct download
                    else {
                        $(el).attr(attr, `${proxyRoute}?url=${encodeURIComponent(absoluteUrl)}`);
                    }
                }
            } catch (e) {
                // Ignore invalid URLs silently
            }
        });

        return $.html();
    }
}

module.exports = ProxyService;
