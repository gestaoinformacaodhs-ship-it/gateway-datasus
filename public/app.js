/* --- VARIÁVEIS GLOBAIS --- */
let arquivosCache = []; 
let sistemaAtivo = '';  
let ticketsSuporte = []; // Armazena os tickets carregados na barra lateral

/* --- NAVEGAÇÃO ENTRE TELAS --- */
function trocar(id) {
    const containers = ['login-container', 'signup-container', 'forgot-container'];
    containers.forEach(c => {
        const el = document.getElementById(c);
        if (el) el.style.display = 'none';
    });
    
    const alvo = document.getElementById(`${id}-container`);
    if (alvo) alvo.style.display = 'block';
}

/* --- FUNÇÃO: EXCLUIR CONTA (NOVA) --- */
async function deletarMinhaConta() {
    const emailUsuario = localStorage.getItem('email');
    
    if (!emailUsuario) {
        alert("Erro: Sessão inválida. Faça login novamente.");
        return logout();
    }

    const confirmacao = confirm("AVISO CRÍTICO:\n\nEsta ação apagará permanentemente seu usuário e todo o histórico de suporte.\n\nDeseja continuar?");
    
    if (confirmacao) {
        const checkEmail = prompt("Para confirmar a exclusão, digite seu e-mail:");
        
        if (checkEmail === emailUsuario) {
            try {
                const response = await fetch('/api/delete-account', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: emailUsuario })
                });

                const result = await response.json();

                if (response.ok) {
                    alert("Sua conta e seus dados foram removidos com sucesso.");
                    logout();
                } else {
                    alert("Erro ao excluir: " + (result.error || "Erro desconhecido"));
                }
            } catch (err) {
                alert("Falha na conexão com o servidor de banco de dados.");
            }
        } else {
            alert("E-mail incorreto. Ação cancelada.");
        }
    }
}

/* --- SUPORTE: GERENCIAMENTO DE TICKETS (ADMIN) --- */

function finalizarTicket(idParaFinalizar) {
    if (!confirm("Deseja realmente encerrar este atendimento?")) return;

    ticketsSuporte = ticketsSuporte.filter(t => t.id !== idParaFinalizar);
    renderizarListaTicketsSuporte();

    const chatMessages = document.getElementById('chat-messages') || document.querySelector('.chat-messages');
    const chatHeader = document.querySelector('.chat-header');
    
    if (chatMessages) chatMessages.innerHTML = '';
    if (chatHeader) chatHeader.innerHTML = '<div class="text-slate-500">Selecione um ticket para iniciar</div>';
}

function renderizarListaTicketsSuporte() {
    const userList = document.querySelector('.user-list');
    if (!userList) return;

    if (ticketsSuporte.length === 0) {
        userList.innerHTML = '<p class="p-4 text-xs text-slate-500">Nenhum ticket aberto.</p>';
        return;
    }

    userList.innerHTML = ticketsSuporte.map(t => `
        <div class="user-item" onclick="selecionarTicket('${t.id}')" id="ticket-${t.id}">
            <div class="flex justify-between items-start">
                <div>
                    <span class="user-name">${t.nome}</span>
                    <span class="last-msg">${t.email || 'Aguardando...'}</span>
                </div>
                <button onclick="event.stopPropagation(); finalizarTicket('${t.id}')" 
                        class="text-[10px] bg-red-500/20 text-red-400 px-2 py-1 rounded hover:bg-red-500 hover:text-white transition-all">
                    FINALIZAR
                </button>
            </div>
        </div>
    `).join('');
}

/* --- SUPORTE: CHAT WIDGET (USUÁRIO) --- */
function toggleChat() {
    const chatWin = document.getElementById('chat-window') || document.getElementById('c-win');
    const badge = document.getElementById('chat-badge');
    
    if (chatWin) {
        const isHidden = chatWin.style.display === 'none' || chatWin.classList.contains('hidden') || !chatWin.classList.contains('active');
        
        // Suporte para ambas as versões de CSS que você enviou
        if (chatWin.classList.contains('active')) {
            chatWin.classList.remove('active');
            chatWin.style.display = 'none';
        } else {
            chatWin.classList.add('active');
            chatWin.style.display = 'flex';
            if (badge) badge.classList.add('hidden');
        }
    }
}

/* --- AUTENTICAÇÃO --- */
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

/* --- DASHBOARD: LISTAR ARQUIVOS --- */
async function abrirEListar(sistema) {
    sistemaAtivo = sistema;
    const modal = document.getElementById('modal');
    const listContainer = document.getElementById('file-list');
    const modalTitle = document.getElementById('modal-title');
    
    if (modal) {
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
    
    if (modalTitle) modalTitle.innerText = `Repositório: ${sistema}`;
    
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
        listContainer.innerHTML = `<div class="p-6 text-center text-red-400">${err.message}</div>`;
    }
}

function renderizarLista(lista) {
    const listContainer = document.getElementById('file-list');
    if (!listContainer) return;

    if (lista.length === 0) {
        listContainer.innerHTML = "<p class='text-center py-10 text-slate-500'>Nenhum arquivo encontrado.</p>";
        return;
    }

    listContainer.innerHTML = lista.map(f => `
        <div class="flex justify-between items-center p-4 rounded-xl mb-2 bg-slate-950/40 border border-white/5 hover:border-blue-900 transition-colors">
            <div class="text-left overflow-hidden mr-4">
                <span class="text-white text-sm font-medium block truncate">${f.name}</span>
                <small class="text-slate-600 text-[10px] font-mono">📅 ${f.rawDate || 'N/D'} | 📦 ${f.size || 'N/D'}</small>
            </div>
            <button onclick="baixarDireto('${sistemaAtivo}', '${f.name}', this)" 
                    class="bg-blue-700/20 text-blue-400 border border-blue-700/50 hover:bg-blue-600 hover:text-white text-[10px] font-black px-4 py-2 rounded-lg transition-all">
                BAIXAR
            </button>
        </div>
    `).join('');
}

function filtrarArquivosModal() {
    const termo = document.getElementById('modalSearch')?.value.toLowerCase();
    const filtrados = arquivosCache.filter(f => f.name.toLowerCase().includes(termo));
    renderizarLista(filtrados);
}

/* --- DOWNLOAD --- */
async function baixarDireto(sistema, arquivo, btn) {
    const originalText = btn.innerText;
    btn.innerText = "AGUARDE...";
    btn.disabled = true;

    try {
        window.location.href = `/api/download/${sistema}/${encodeURIComponent(arquivo)}`;
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
    document.body.style.overflow = 'auto';
}

/* --- INICIALIZAÇÃO --- */
document.addEventListener('DOMContentLoaded', () => {
    const usuarioLogado = localStorage.getItem('usuario');
    const emailLogado = localStorage.getItem('email');
    const isDashboard = window.location.pathname.includes('dashboard.html');

    // Proteção de rota
    if (isDashboard && !emailLogado) {
        window.location.replace('index.html');
        return; 
    }

    const display = document.getElementById('user-display');
    if (display) display.innerText = usuarioLogado ? `Olá, ${usuarioLogado}` : "Olá, Usuário";

    // Eventos de Busca
    document.getElementById('modalSearch')?.addEventListener('input', filtrarArquivosModal);
    
    // Evento de Tecla Enter no Chat
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                if (typeof enviarMensagem === 'function') {
                    enviarMensagem();
                }
            }
        });
    }

    // Inicializa lista de suporte se estiver no console admin
    if (document.querySelector('.user-list')) {
        renderizarListaTicketsSuporte();
    }
});

function logout() {
    localStorage.clear();
    window.location.replace('index.html');
}