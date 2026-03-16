// --- VARIÁVEIS GLOBAIS PARA BUSCA ---
let arquivosCache = []; 
let sistemaAtivo = '';  

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
    const chatWin = document.getElementById('c-win') || document.getElementById('chat-window');
    const badge = document.getElementById('chat-badge');
    
    if (chatWin) {
        const isHidden = chatWin.classList.contains('hidden') || chatWin.style.display === 'none';
        chatWin.style.display = isHidden ? 'flex' : 'none';
        chatWin.classList.toggle('hidden', !isHidden);
        
        if (isHidden && badge) badge.classList.add('hidden');
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
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Autenticando...';
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
            alert(data.error || "Credenciais inválidas.");
        }
    } catch (err) {
        alert("Erro de comunicação com o servidor.");
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = "Entrar no Sistema";
        }
    }
}

// --- DASHBOARD: LISTAR ARQUIVOS FTP ---
async function abrirEListar(sistema) {
    sistemaAtivo = sistema;
    const modal = document.getElementById('modal');
    const listContainer = document.getElementById('file-list');
    const modalTitle = document.getElementById('modal-title');
    
    if (modal) {
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden'; // Trava scroll do fundo
    }
    
    if (modalTitle) modalTitle.innerText = `Repositório: ${sistema}`;
    document.getElementById('modalSearch').value = ""; 
    
    listContainer.innerHTML = `
        <div class="py-10 text-center">
            <div class="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-blue-500 mb-4"></div>
            <p class="text-blue-400 font-bold">Conectando ao DATASUS...</p>
        </div>
    `;

    try {
        const res = await fetch(`/api/list/${sistema}`);
        const files = await res.json();

        if (!res.ok) throw new Error(files.error || "Erro ao listar arquivos.");

        arquivosCache = Array.isArray(files) ? files : []; 
        renderizarLista(arquivosCache);
    } catch (err) {
        listContainer.innerHTML = `
            <div class="p-6 text-center border border-red-500/20 rounded-xl bg-red-500/5">
                <p class="text-red-400 text-sm font-bold">${err.message}</p>
                <button onclick="abrirEListar('${sistema}')" class="mt-4 text-[10px] underline text-slate-500">Tentar novamente</button>
            </div>`;
    }
}

function renderizarLista(lista) {
    const listContainer = document.getElementById('file-list');
    if (!listContainer) return;

    if (lista.length === 0) {
        listContainer.innerHTML = "<p class='text-center py-10 text-slate-500'>Nenhum arquivo encontrado.</p>";
        return;
    }

    listContainer.innerHTML = lista.map(f => {
        const dataFormatada = f.rawDate ? new Date(f.rawDate).toLocaleDateString('pt-BR') : 'Data n/d';
        return `
            <div class="flex justify-between items-center p-4 rounded-xl mb-2 bg-slate-800/40 border border-white/5 hover:border-blue-500/30 transition-all">
                <div class="text-left overflow-hidden mr-4">
                    <span class="text-white text-sm font-medium block truncate" title="${f.name}">${f.name}</span>
                    <small class="text-slate-500 text-[10px] font-mono uppercase tracking-tighter">
                        📅 ${dataFormatada} | 📦 ${f.size}
                    </small>
                </div>
                <button onclick="baixarDireto('${sistemaAtivo}', '${f.name}', this)" 
                        class="bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black px-4 py-2 rounded-lg transition-all shrink-0">
                    BAIXAR
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
async function baixarDireto(sistema, arquivo, btn) {
    const originalText = btn.innerText;
    btn.innerText = "AGUARDE...";
    btn.disabled = true;

    try {
        // Em vez de criar link <a> direto, verificamos a disponibilidade via fetch (opcional)
        // Ou mantemos o download via URL para arquivos grandes
        const url = `/api/download/${sistema}/${encodeURIComponent(arquivo)}`;
        
        const a = document.createElement('a');
        a.href = url;
        a.download = arquivo;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (err) {
        alert("Erro ao iniciar download.");
    } finally {
        setTimeout(() => {
            btn.innerText = originalText;
            btn.disabled = false;
        }, 1500);
    }
}

function fecharModal() {
    const modal = document.getElementById('modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = 'auto'; // Restaura o scroll
}

// --- INICIALIZAÇÃO E PROTEÇÃO DE ROTA ---
document.addEventListener('DOMContentLoaded', () => {
    const usuarioLogado = localStorage.getItem('usuario');
    const isDashboard = window.location.pathname.includes('dashboard.html');

    // Proteção de rota imediata
    if (isDashboard && !usuarioLogado) {
        window.location.replace('index.html');
        return; 
    }

    const display = document.getElementById('user-display');
    if (display) {
        display.innerText = usuarioLogado ? `Olá, ${usuarioLogado}` : "Olá, Usuário";
    }

    // Listener para busca automática (com debouncing simples)
    const inputBusca = document.getElementById('modalSearch');
    if (inputBusca) {
        inputBusca.addEventListener('input', filtrarArquivosModal);
    }

    // Listener para o Enter no chat
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                if (typeof window.enviarMensagem === 'function') window.enviarMensagem();
            }
        });
    }
});

function logout() {
    localStorage.clear();
    window.location.replace('index.html');
}