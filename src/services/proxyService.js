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
     * Resolves a potentially relative URL against a base, and routes it
     * through our HTTPS proxy if it belongs to a DATASUS/MS domain.
     * Returns null if the URL should not be rewritten.
     */
    static resolveAndRewrite(val, targetBaseUrl, proxyRoute) {
        if (!val) return null;
        if (val.startsWith('javascript:') || val.startsWith('#') || val.startsWith('data:') || val.startsWith('mailto:')) return null;

        // FTP links → our server-side FTP download proxy (root-relative, always HTTPS)
        if (val.startsWith('ftp://')) {
            return `/api/ftp-proxy?url=${encodeURIComponent(val)}`;
        }

        try {
            const absoluteUrl = new URL(val, targetBaseUrl).href;
            if (absoluteUrl.includes('datasus.gov.br') || absoluteUrl.includes('saude.gov.br')) {
                return `${proxyRoute}?url=${encodeURIComponent(absoluteUrl)}`;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    /**
     * Rewrites url(...) expressions inside a CSS string, routing them through proxy.
     */
    static rewriteCssUrls(cssText, targetBaseUrl, proxyRoute) {
        return cssText.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (match, quote, url) => {
            const rewritten = ProxyService.resolveAndRewrite(url, targetBaseUrl, proxyRoute);
            return rewritten ? `url(${quote}${rewritten}${quote})` : match;
        });
    }

    /**
     * Injects modern CSS and rewrites ALL resources to go through our HTTPS proxy.
     * This prevents Mixed Content errors (DATASUS is HTTP, our server is HTTPS).
     *
     * @param {string} html - Raw HTML from DATASUS server
     * @param {string} proxyRoute - e.g. /api/sia-proxy or /api/sihd-proxy
     * @param {string} targetBaseUrl - Full absolute URL of the proxied page
     */
    static injectCustomAssets(html, proxyRoute, targetBaseUrl) {
        const $ = cheerio.load(html);

        // ── Rewrite <img src>, <script src>, <link href>, <a href>, <form action> ──
        $('img, script, input[src]').each((i, el) => {
            const val = $(el).attr('src');
            const rewritten = ProxyService.resolveAndRewrite(val, targetBaseUrl, proxyRoute);
            if (rewritten) $(el).attr('src', rewritten);
        });

        $('link').each((i, el) => {
            const val = $(el).attr('href');
            const rewritten = ProxyService.resolveAndRewrite(val, targetBaseUrl, proxyRoute);
            if (rewritten) $(el).attr('href', rewritten);
        });

        $('a').each((i, el) => {
            const val = $(el).attr('href');
            const rewritten = ProxyService.resolveAndRewrite(val, targetBaseUrl, proxyRoute);
            if (rewritten) {
                $(el).attr('href', rewritten);
                // For FTP links, mark as download
                if (val && val.startsWith('ftp://')) $(el).attr('download', '');
            }
        });

        $('form').each((i, el) => {
            const val = $(el).attr('action');
            const rewritten = ProxyService.resolveAndRewrite(val, targetBaseUrl, proxyRoute);
            if (rewritten) $(el).attr('action', rewritten);
        });

        // ── Rewrite url() in inline style="" attributes ──
        $('[style]').each((i, el) => {
            const style = $(el).attr('style');
            if (style && style.includes('url(')) {
                $(el).attr('style', ProxyService.rewriteCssUrls(style, targetBaseUrl, proxyRoute));
            }
        });

        // ── Rewrite url() inside <style> blocks ──
        $('style').each((i, el) => {
            const css = $(el).html();
            if (css && css.includes('url(')) {
                $(el).html(ProxyService.rewriteCssUrls(css, targetBaseUrl, proxyRoute));
            }
        });

        // ── Inject modern dark theme styles ──
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

        // ── Banner ──
        $('body').prepend('<div class="gateway-banner">Acesso via Gateway DATASUS Profissional</div>');

        return $.html();
    }
}

module.exports = ProxyService;
