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
     * Injects modern CSS and scripts into the DATASUS HTML.
     */
    static injectCustomAssets(html, proxyRoute, targetBaseUrl) {
        const $ = cheerio.load(html);

        // Inject modern dark theme styles
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

        // Prepend a banner to indicate it's via Gateway
        $('body').prepend('<div class="gateway-banner">Acesso via Gateway DATASUS Profissional</div>');

        // Rewrite links and resources
        $('a, img, script, link, form').each((i, el) => {
            const attr = el.name === 'form' ? 'action' : (el.name === 'link' || el.name === 'a' ? 'href' : 'src');
            let val = $(el).attr(attr);

            if (!val || val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('data:')) return;

            if (val.startsWith('ftp://')) {
                $(el).attr('href', `/api/ftp-download?url=${encodeURIComponent(val)}`);
                return;
            }

            try {
                const absoluteUrl = new URL(val, targetBaseUrl).href;
                if (absoluteUrl.includes('datasus.gov.br')) {
                    $(el).attr(attr, `${proxyRoute}?url=${encodeURIComponent(absoluteUrl)}`);
                }
            } catch (e) {
                // Ignore invalid URLs
            }
        });

        return $.html();
    }
}

module.exports = ProxyService;
