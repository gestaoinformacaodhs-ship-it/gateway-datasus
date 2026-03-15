// --- VARIÁVEIS GLOBAIS PARA BUSCA ---
let arquivosCache = []; // Armazena a lista vinda do FTP para filtrar sem novo fetch
let sistemaAtivo = '';  // Guarda qual sistema (SIA, CNES, etc) está aberto

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
    const chatWin = document.getElementById('c-win') || document.getElementById('chat-window');
    const badge = document.getElementById('chat-badge');
    
    if (chatWin) {
        const isHidden = chatWin.style.display === 'none' || chatWin.classList.contains('hidden');
        chatWin.style.display = isHidden ? 'flex' : 'none';
        chatWin.classList.toggle('hidden', !isHidden);
        
        if (isHidden && badge) {
            badge.classList.add('hidden');
        }
    }
}

// --- AUTENTICAÇÃO: LOGIN ---
async function entrar() {
    const emailInput = document.getElementById('l-email');
    const senhaInput = document.getElementById('l-pass');
    const btn = document.getElementById('btn-entrar');

    const email = emailInput?.value.trim();
    const senha = senhaInput?.value;

    if (!email || !senha) return alert("Por favor, preencha todos os campos.");

    if (btn) {
        btn.disabled = true;
        btn.innerText = "Acessando...";
    }

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, senha })
        });

        const data = await res.json();

        if (res.ok) {
            localStorage.setItem('usuario', data.user);
            localStorage.setItem('email', data.email); 
            window.location.href = 'dashboard.html';
        } else {
            alert(data.error || "E-mail ou senha incorretos.");
        }
    } catch (err) {
        console.error("Erro no login:", err);
        alert("Erro de conexão com o servidor.");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Entrar no Sistema";
        }
    }
}

// --- AUTENTICAÇÃO: REGISTRO ---
async function registar() {
    const nome = document.getElementById('r-nome')?.value.trim();
    const email = document.getElementById('r-email')?.value.trim();
    const senha = document.getElementById('r-pass')?.value;
    const btn = document.getElementById('btn-registrar');

    if (!nome || !email || !senha) return alert("Preencha todos os campos.");

    if (btn) {
        btn.innerText = "Enviando e-mail...";
        btn.disabled = true;
    }

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, email, senha })
        });

        const data = await res.json();

        if (res.ok) {
            alert("✅ " + data.message);
            trocar('login');
        } else {
            alert("❌ " + (data.error || "Erro ao criar conta."));
        }
    } catch (err) {
        alert("Erro ao processar registro.");
    } finally {
        if (btn) {
            btn.innerText = "Finalizar Cadastro";
            btn.disabled = false;
        }
    }
}

// --- AUTENTICAÇÃO: RECUPERAÇÃO DE SENHA ---
async function esqueciSenha() {
    const email = document.getElementById('f-email')?.value.trim();
    const btn = document.getElementById('btn-forgot');

    if (!email) return alert("Digite seu e-mail.");

    if (btn) {
        btn.disabled = true;
        btn.innerText = "Enviando...";
    }

    try {
        const res = await fetch('/api/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        alert(data.message || data.error);
        if (res.ok) trocar('login');
    } catch (err) {
        alert("Erro ao solicitar recuperação.");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Recuperar Senha";
        }
    }
}

// --- DASHBOARD: LISTAR ARQUIVOS FTP ---
async function abrirEListar(sistema) {
    sistemaAtivo = sistema;
    const modal = document.getElementById('modal');
    const listContainer = document.getElementById('file-list');
    const modalTitle = document.getElementById('modal-title');
    const inputBusca = document.getElementById('modalSearch');
    
    if (modal) modal.style.display = 'flex';
    if (modalTitle) modalTitle.innerText = `Repositório: ${sistema}`;
    if (inputBusca) inputBusca.value = ""; 
    
    if (listContainer) {
        listContainer.innerHTML = `
            <div style="text-align:center; padding:40px;">
                <div class="spinner" style="margin: 0 auto 10px auto;"></div>
                <p style="color:#3b82f6; font-weight:bold;">Conectando ao DATASUS...</p>
                <small style="color:#64748b;">Buscando as remessas mais recentes...</small>
            </div>
        `;
    }

    try {
        const res = await fetch(`/api/list/${sistema}`);
        const files = await res.json();

        if (!res.ok) throw new Error(files.error);

        // O backend já envia ordenado, mas garantimos aqui a integridade do cache
        arquivosCache = files || []; 
        renderizarLista(arquivosCache);
    } catch (err) {
        if (listContainer) {
            listContainer.innerHTML = `<p style='color:#ef4444; text-align:center; padding:40px;'>${err.message || "Falha ao conectar ao FTP."}</p>`;
        }
    }
}

function renderizarLista(lista) {
    const listContainer = document.getElementById('file-list');
    if (!listContainer) return;

    if (lista.length === 0) {
        listContainer.innerHTML = "<p style='text-align:center; padding:40px; color:#64748b;'>Nenhum arquivo encontrado.</p>";
        return;
    }

    listContainer.innerHTML = lista.map(f => {
        // Formata a data vinda do servidor para o padrão brasileiro
        const dataFormatada = f.rawDate ? new Date(f.rawDate).toLocaleDateString('pt-BR') : 'Data n/d';

        return `
            <div class="file-item flex justify-between items-center p-4 rounded-xl mb-2 bg-slate-800/40 border border-white/5 hover:border-blue-500/30 transition-all">
                <div style="text-align:left;">
                    <span class="text-white text-sm font-medium block">${f.name}</span>
                    <small class="text-slate-500 text-[10px]">📅 ${dataFormatada} | 📦 ${f.size}</small>
                </div>
                <button onclick="baixarDireto('${sistemaAtivo}', '${f.name}', this)" 
                        class="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold px-4 py-2 rounded-lg transition-all">
                    Baixar
                </button>
            </div>
        `;
    }).join('');
}

function filtrarArquivosModal() {
    const termo = document.getElementById('modalSearch')?.value.toLowerCase();
    const filtrados = arquivosCache.filter(arquivo => 
        arquivo.name.toLowerCase().includes(termo)
    );
    renderizarLista(filtrados);
}

// --- DASHBOARD: DOWNLOAD ---
function baixarDireto(sistema, arquivo, btn) {
    const url = `/api/download/${sistema}/${encodeURIComponent(arquivo)}`;
    const originalText = btn.innerText;
    
    btn.innerText = "Aguarde...";
    btn.disabled = true;

    // Criar link temporário
    const a = document.createElement('a');
    a.href = url;
    a.download = arquivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => {
        btn.innerText = originalText;
        btn.disabled = false;
    }, 2000);
}

function fecharModal() {
    const modal = document.getElementById('modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = 'auto';
}

// --- INICIALIZAÇÃO E PROTEÇÃO DE ROTA ---
document.addEventListener('DOMContentLoaded', () => {
    const display = document.getElementById('user-display');
    const usuarioLogado = localStorage.getItem('usuario');

    if (display) {
        display.innerText = usuarioLogado ? `Olá, ${usuarioLogado}` : "Olá, Usuário";
    }

    // Proteção de rota
    const isDashboard = window.location.pathname.includes('dashboard.html');
    if (isDashboard && !usuarioLogado) {
        window.location.href = 'index.html'; 
    }

    // Listener para busca automática
    const inputBusca = document.getElementById('modalSearch');
    if (inputBusca) {
        inputBusca.addEventListener('input', filtrarArquivosModal);
    }

    // Listener para o Enter no chat
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const func = window.enviarMensagem;
                if (typeof func === 'function') func();
            }
        });
    }
});

function logout() {
    localStorage.clear();
    window.location.href = 'index.html';
}