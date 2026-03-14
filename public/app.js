// --- NAVEGAÇÃO ENTRE TELAS ---
function trocar(id) {
    const containers = ['login-container', 'signup-container', 'forgot-container'];
    containers.forEach(c => {
        const el = document.getElementById(c);
        if (el) el.style.display = 'none';
    });
    
    const alvo = document.getElementById(`${id}-container`);
    if (alvo) alvo.style.display = 'block';
}

// --- SUPORTE: CHAT WIDGET ---
function toggleChat() {
    const chatWin = document.getElementById('c-win');
    if (chatWin) {
        chatWin.classList.toggle('hidden');
        chatWin.style.display = chatWin.classList.contains('hidden') ? 'none' : 'flex';
    }
}

// --- AUTENTICAÇÃO: LOGIN ---
async function entrar() {
    const email = document.getElementById('l-email')?.value;
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
        alert("Erro de conexão com o servidor.");
    }
}

// --- AUTENTICAÇÃO: REGISTRO ---
async function registar() {
    const nome = document.getElementById('r-nome')?.value;
    const email = document.getElementById('r-email')?.value;
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
    const email = document.getElementById('f-email')?.value;
    const btn = document.getElementById('btn-forgot');

    if (!email) return alert("Por favor, digite seu e-mail.");

    // Muda o estado do botão para o usuário saber que está processando
    btn.innerText = "Enviando e-mail real...";
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
            alert("SUCESSO! O link foi enviado para o seu Gmail.");
            trocar('login');
        } else {
            alert(data.error || "Erro: E-mail não cadastrado.");
        }
    } catch (err) {
        alert("Erro técnico: Não foi possível conectar ao servidor.");
    } finally {
        btn.innerText = "Enviar Instruções Real";
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
                <div class="spinner" style="border: 4px solid rgba(255,255,255,0.1); border-left-color: #3b82f6; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 0 auto 15px;"></div>
                <p style="color:#3b82f6; font-weight:bold; margin:0;">Conectando ao DATASUS...</p>
                <small style="color:#64748b;">Aguarde a resposta do servidor FTP</small>
            </div>
            <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
        `;
    }

    try {
        const res = await fetch(`/api/list/${sistema}`);
        if (!res.ok) throw new Error("Erro na lista");

        const files = await res.json();

        if (!files || files.length === 0) {
            listContainer.innerHTML = "<p style='text-align:center; padding:40px; color:#64748b;'>Nenhum arquivo encontrado neste diretório.</p>";
            return;
        }

        listContainer.innerHTML = files.map(f => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:15px; border-bottom:1px solid rgba(255,255,255,0.05);">
                <div style="text-align:left;">
                    <span style="color:white; font-size:0.9rem; font-weight:500; display:block;">${f.name}</span>
                    <small style="color:#64748b;">${f.size}</small>
                </div>
                <button onclick="baixarDireto('${sistema}', '${f.name}', this)" 
                        class="btn-download"
                        style="background:#3b82f6; color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:bold; transition: 0.2s;">
                    Baixar
                </button>
            </div>
        `).join('');
    } catch (err) {
        listContainer.innerHTML = "<p style='color:#ef4444; text-align:center; padding:40px;'>Erro ao carregar arquivos do FTP. Tente novamente.</p>";
    }
}

// --- DASHBOARD: DOWNLOAD (CORREÇÃO DEFINITIVA) ---
function baixarDireto(sistema, arquivo, btn) {
    const url = `/api/download/${sistema}/${encodeURIComponent(arquivo)}`;
    
    const originalText = btn.innerText;
    btn.innerText = "Iniciando...";
    btn.style.opacity = "0.6";
    btn.disabled = true;

    let iframe = document.getElementById('download-iframe');
    if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.id = 'download-iframe';
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
    }
    iframe.src = url;

    setTimeout(() => {
        btn.innerText = originalText;
        btn.style.opacity = "1";
        btn.disabled = false;
    }, 10000);
}

function fecharModal() {
    const modal = document.getElementById('modal');
    if (modal) modal.style.display = 'none';
}

// --- INICIALIZAÇÃO ---
document.addEventListener('DOMContentLoaded', () => {
    const display = document.getElementById('user-display');
    if (display) {
        const user = localStorage.getItem('usuario');
        display.innerText = user ? `Olá, ${user}` : "Olá, Usuário";
    }

    if (window.location.pathname.includes('dashboard.html')) {
        if (!localStorage.getItem('usuario')) {
            window.location.href = 'index.html'; 
        }
    }
});

function logout() {
    localStorage.removeItem('usuario');
    window.location.href = 'index.html';
}