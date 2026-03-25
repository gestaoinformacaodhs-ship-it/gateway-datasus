const http = require('http');
const fs = require('fs');
http.get('http://sia.datasus.gov.br/principal/index.php', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const regex = /<area[^>]+href=["']([^"']+)["'][^>]*>/gi;
        let match;
        let output = '';
        while ((match = regex.exec(data)) !== null) {
            output += match[1] + '\n';
        }
        fs.writeFileSync('urls_parsed.txt', output);
    });
});
