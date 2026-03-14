// --- NAVEGAÇÃO ENTRE TELAS ---
function trocar(id) {
    const containers = ['login-container', 'signup-container', 'forgot-container'];
    containers.forEach(c => {
        const el = document.getElementById(c);
        if (el) el.style.display = 'none';
    });
    
    const alvo = document.getElementById(`${id}-container`);
    if (alvo) {
        alvo.style.display = 'block';
    }
}

// --- SUPORTE: CHAT WIDGET ---
function toggleChat() {
    const chatWin = document.getElementById('c-win');
    if (chatWin) {
        // Alterna entre flex e none para manter o layout centralizado do chat
        const isHidden = chatWin.style.display === 'none' || chatWin.classList.contains('hidden');
        chatWin.style.display = isHidden ? 'flex' : 'none';
        chatWin.classList.toggle('hidden', !isHidden);
    }
}

// --- AUTENTICAÇÃO: LOGIN ---
async function entrar() {
    const email = document.getElementById('l-email')?.value.trim();
    const senha = document.getElementById('l-pass')?.value;

    if (!email || !senha) return alert("Por favor, preencha todos os campos.");

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, senha })
        });

        const data = await res.json();

        if (res.ok) {
            localStorage.setItem('usuario', data.user);
            window.location.href = 'dashboard.html';
        } else {
            alert(data.error || "E-mail ou senha incorretos.");
        }
    } catch (err) {
        console.error("Erro no login:", err);
        alert("Erro de conexão com o servidor. Verifique se o back-end está rodando.");
    }
}

// --- AUTENTICAÇÃO: REGISTRO ---
async function registar() {
    const nome = document.getElementById('r-nome')?.value.trim();
    const email = document.getElementById('r-email')?.value.trim();
    const senha = document.getElementById('r-pass')?.value;

    if (!nome || !email || !senha) return alert("Preencha todos os campos.");

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, email, senha })
        });

        if (res.ok) {
            alert("Conta criada com sucesso!");
            trocar('login');
        } else {
            const data = await res.json();
            alert(data.error || "Erro ao criar conta.");
        }
    } catch (err) {
        alert("Erro ao processar registro.");
    }
}

// --- AUTENTICAÇÃO: RECUPERAÇÃO DE SENHA (SOLICITAR TOKEN) ---
async function solicitarRecuperacao() {
    const email = document.getElementById('f-email')?.value.trim();
    const btn = document.getElementById('btn-forgot');

    if (!email) return alert("Por favor, digite seu e-mail.");

    // Feedback visual de processamento
    const textoOriginal = btn.innerText;
    btn.innerText = "Processando...";
    btn.disabled = true;
    btn.style.opacity = "0.7";

    try {
        const res = await fetch('/api/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });

        const data = await res.json();

        if (res.ok) {
            alert("Sucesso! Verifique seu e-mail para recuperar a senha.");
            trocar('login');
        } else {
            alert(data.error || "E-mail não encontrado.");
        }
    } catch (err) {
        alert("Não foi possível conectar ao servidor de e-mail.");
    } finally {
        btn.innerText = textoOriginal;
        btn.disabled = false;
        btn.style.opacity = "1";
    }
}

// --- DASHBOARD: LISTAR ARQUIVOS FTP ---
async function abrirEListar(sistema) {
    const modal = document.getElementById('modal');
    const listContainer = document.getElementById('file-list');
    const modalTitle = document.getElementById('modal-title');
    
    if (modal) modal.style.display = 'flex';
    if (modalTitle) modalTitle.innerText = `Repositório: ${sistema}`;
    
    if (listContainer) {
        listContainer.innerHTML = `
            <div style="text-align:center; padding:40px;">
                <div class="spinner"></div>
                <p style="color:#3b82f6; font-weight:bold; margin-top:15px;">Conectando ao DATASUS...</p>
                <small style="color:#64748b;">Isso pode levar alguns segundos</small>
            </div>
        `;
    }

    try {
        const res = await fetch(`/api/list/${sistema}`);
        if (!res.ok) throw new Error("Erro na lista");

        const files = await res.json();

        if (!files || files.length === 0) {
            listContainer.innerHTML = "<p style='text-align:center; padding:40px; color:#64748b;'>Nenhum arquivo encontrado.</p>";
            return;
        }

        listContainer.innerHTML = files.map(f => `
            <div class="file-item" style="display:flex; justify-content:space-between; align-items:center; padding:12px; border-bottom:1px solid rgba(255,255,255,0.05);">
                <div style="text-align:left;">
                    <span style="color:white; font-size:0.85rem; font-weight:500; display:block;">${f.name}</span>
                    <small style="color:#64748b;">${f.size}</small>
                </div>
                <button onclick="baixarDireto('${sistema}', '${f.name}', this)" 
                        style="background:#3b82f6; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:0.8rem;">
                    Baixar
                </button>
            </div>
        `).join('');
    } catch (err) {
        listContainer.innerHTML = "<p style='color:#ef4444; text-align:center; padding:40px;'>Falha ao conectar ao FTP. Tente novamente mais tarde.</p>";
    }
}

// --- DASHBOARD: DOWNLOAD ---
function baixarDireto(sistema, arquivo, btn) {
    const url = `/api/download/${sistema}/${encodeURIComponent(arquivo)}`;
    
    const originalText = btn.innerText;
    btn.innerText = "Baixando...";
    btn.disabled = true;

    // Criar um link invisível para disparar o download sem sair da página
    const a = document.createElement('a');
    a.href = url;
    a.download = arquivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Reativar botão após um delay
    setTimeout(() => {
        btn.innerText = originalText;
        btn.disabled = false;
    }, 3000);
}

function fecharModal() {
    const modal = document.getElementById('modal');
    if (modal) modal.style.display = 'none';
}

// --- INICIALIZAÇÃO ---
document.addEventListener('DOMContentLoaded', () => {
    // Verificar exibição do nome do usuário
    const display = document.getElementById('user-display');
    const usuarioLogado = localStorage.getItem('usuario');

    if (display) {
        display.innerText = usuarioLogado ? `Olá, ${usuarioLogado}` : "Olá, Usuário";
    }

    // Proteção de rota para Dashboard
    if (window.location.pathname.includes('dashboard.html')) {
        if (!usuarioLogado) {
            window.location.href = 'index.html'; 
        }
    }
});

function logout() {
    localStorage.removeItem('usuario');
    window.location.href = 'index.html';
}