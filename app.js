const CATEGORIES = ["TI", "Infraestrutura", "Facilities", "RH", "Suprimentos"];
const PRIORITIES = ["baixa", "media", "alta", "urgente"];
const STATUSES = ["aberto", "andamento", "aguardando", "resolvido", "encerrado"];
const LABELS = {
  baixa: "Baixa", media: "Média", alta: "Alta", urgente: "Urgente",
  aberto: "Aberto", andamento: "Em andamento", aguardando: "Aguardando",
  resolvido: "Resolvido", encerrado: "Encerrado",
  colaborador: "Colaborador", atendente: "Atendente", admin: "Administração",
};

let db = null;
let state = { user: null, offices: [], users: [], tickets: [] };
let route = parseHash();
let flashError = "";
let flashSuccess = "";
let loading = true;

function parseHash() {
  if (new URLSearchParams(location.search).has("auth-recovery")) return { name: "reset-password", id: null };
  const parts = (location.hash || "#/login").replace(/^#/, "").split("/").filter(Boolean);
  return { name: parts[0] || "login", id: parts[1] || null };
}

function go(path) { location.hash = path; }
function now() { return new Date().toISOString(); }
function formatDate(value) {
  return new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function currentUser() { return state.user; }
function officeById(id) { return state.offices.find((office) => office.id === id); }
function userById(id) { return state.users.find((user) => user.id === id); }
function canManage(user) { return user?.role === "atendente" || user?.role === "admin"; }
function visibleTickets(user) {
  return user.role === "colaborador" ? state.tickets.filter((ticket) => ticket.requesterId === user.id) : state.tickets.slice();
}
function checkError(result) {
  if (result.error) throw result.error;
  return result.data;
}

function mapOffice(row) { return { id: row.id, name: row.name, city: row.city, address: row.address }; }
function mapUser(row) { return { id: row.id, name: row.name, role: row.role, officeId: row.office_id }; }
function mapTicket(row) {
  return {
    id: row.id, number: `HD-${row.ticket_no}`, title: row.title, description: row.description,
    category: row.category, priority: row.priority, status: row.status, officeId: row.office_id,
    requesterId: row.requester_id, assigneeId: row.assignee_id, createdAt: row.created_at,
    updatedAt: row.updated_at, comments: [], events: [],
  };
}

async function loadWorkspace() {
  const { data: authData, error: authError } = await db.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) {
    state = { user: null, offices: [], users: [], tickets: [] };
    render();
    return;
  }

  const profileResult = await db.from("profiles").select("id,name,role,office_id").eq("id", authData.user.id).maybeSingle();
  if (profileResult.error) throw profileResult.error;
  if (!profileResult.data) {
    await db.auth.signOut();
    throw new Error("Sua conta foi autenticada, mas ainda não tem perfil cadastrado. Peça ao administrador para concluir seu acesso.");
  }
  const profile = profileResult.data;
  const [officeRows, userRows, ticketRows, commentRows, eventRows] = await Promise.all([
    db.from("offices").select("id,name,city,address").order("name"),
    db.from("profiles").select("id,name,role,office_id").order("name"),
    db.from("tickets").select("id,ticket_no,title,description,category,priority,status,office_id,requester_id,assignee_id,created_at,updated_at").order("updated_at", { ascending: false }),
    db.from("ticket_comments").select("id,ticket_id,author_id,body,created_at").order("created_at"),
    db.from("ticket_events").select("id,ticket_id,actor_id,body,created_at").order("created_at"),
  ]);
  state.offices = checkError(officeRows).map(mapOffice);
  state.users = checkError(userRows).map(mapUser);
  state.tickets = checkError(ticketRows).map(mapTicket);
  for (const row of checkError(commentRows)) {
    const ticket = state.tickets.find((item) => item.id === row.ticket_id);
    if (ticket) ticket.comments.push({ id: row.id, authorId: row.author_id, body: row.body, createdAt: row.created_at });
  }
  for (const row of checkError(eventRows)) {
    const ticket = state.tickets.find((item) => item.id === row.ticket_id);
    if (ticket) ticket.events.push({ id: row.id, authorId: row.actor_id, body: row.body, createdAt: row.created_at });
  }
  state.user = mapUser(profile);
  loading = false;
  render();
}

function showError(error) {
  flashError = error?.message || "Não foi possível concluir a operação. Tente novamente.";
  loading = false;
  render();
}

async function login(email, password) {
  flashError = "";
  try {
    const result = await db.auth.signInWithPassword({ email: email.trim(), password });
    if (result.error) throw result.error;
    await loadWorkspace();
    if (state.user) go("/dashboard");
  } catch (error) { showError(error); }
}

async function logout() {
  const { error } = await db.auth.signOut();
  if (error) return showError(error);
  state = { user: null, offices: [], users: [], tickets: [] };
  flashError = "";
  go("/login");
  render();
}

async function createTicket(payload) {
  const user = currentUser();
  const officeId = user.role === "colaborador" ? user.officeId : payload.officeId;
  try {
    const result = await db.from("tickets").insert({
      title: payload.title.trim(), description: payload.description.trim(), category: payload.category,
      priority: payload.priority, office_id: officeId, requester_id: user.id,
    }).select("id").single();
    const ticket = checkError(result);
    await loadWorkspace();
    go(`/tickets/${ticket.id}`);
  } catch (error) { showError(error); }
}

async function updateTicket(id, patch) {
  const row = {
    status: patch.status, priority: patch.priority, assignee_id: patch.assigneeId || null,
  };
  try {
    checkError(await db.from("tickets").update(row).eq("id", id).select("id").single());
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function addComment(id, body) {
  if (!body.trim()) return;
  try {
    checkError(await db.from("ticket_comments").insert({ ticket_id: id, author_id: currentUser().id, body: body.trim() }));
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function addOffice(payload) {
  try {
    checkError(await db.from("offices").insert({ name: payload.name.trim(), city: payload.city.trim(), address: payload.address.trim() }));
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function sendPasswordRecovery(email) {
  flashError = "";
  flashSuccess = "";
  try {
    const redirectTo = `${location.origin}${location.pathname}?auth-recovery=1`;
    const { error } = await db.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    if (error) throw error;
    flashSuccess = "Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.";
    render();
  } catch (error) { showError(error); }
}

async function setNewPassword(password) {
  flashError = "";
  flashSuccess = "";
  try {
    const { error } = await db.auth.updateUser({ password });
    if (error) throw error;
    await db.auth.signOut();
    state = { user: null, offices: [], users: [], tickets: [] };
    history.replaceState(null, "", `${location.pathname}#/login`);
    route = { name: "login", id: null };
    flashSuccess = "Senha atualizada. Entre com a nova senha.";
    render();
  } catch (error) { showError(error); }
}

async function createEmployee(payload) {
  flashError = "";
  flashSuccess = "";
  try {
    const { data, error } = await db.functions.invoke("clever-function", { body: payload });
    if (error) {
      let message = error.message;
      try {
        const response = await error.context.json();
        message = response.error || message;
      } catch { /* Keep the SDK's message when the response has no JSON body. */ }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    flashSuccess = `A conta de ${payload.name.trim()} foi criada.`;
    await loadWorkspace();
    const form = document.getElementById("user-form");
    if (form) form.reset();
    render();
  } catch (error) { showError(error); }
}

function badgeStatus(status) { return `<span class="badge st-${escapeHtml(status)}">${LABELS[status] || escapeHtml(status)}</span>`; }
function badgePriority(priority) { return `<span class="badge pr-${escapeHtml(priority)}">${LABELS[priority] || escapeHtml(priority)}</span>`; }

function layout(user, title, actions, content) {
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand-mark" style="margin:4px 8px 22px"><div class="logo-tile">H</div>Hekp Gesk</div>
        <button class="nav-btn ${route.name === "dashboard" ? "active" : ""}" data-go="/dashboard">Painel</button>
        <button class="nav-btn ${route.name === "tickets" && !route.id ? "active" : ""}" data-go="/tickets">Chamados</button>
        <button class="nav-btn ${route.name === "new" ? "active" : ""}" data-go="/new">Abrir chamado</button>
        <button class="nav-btn ${route.name === "offices" ? "active" : ""}" data-go="/offices">Escritórios</button>
        ${user.role === "admin" ? `<button class="nav-btn ${route.name === "users" ? "active" : ""}" data-go="/users">Equipe</button>` : ""}
        <div class="user-box"><strong>${escapeHtml(user.name)}</strong><br />${LABELS[user.role]} · ${escapeHtml(officeById(user.officeId)?.city || "")}
          <button type="button" id="logout">Sair</button>
        </div>
      </aside>
      <main class="main">
        <div class="topbar"><div><div class="hint" style="margin:0 0 4px">Help Desk dos Escritórios</div><h1>${escapeHtml(title)}</h1></div><div>${actions || ""}</div></div>
        ${flashError ? `<p class="error" role="alert">${escapeHtml(flashError)}</p>` : ""}
        ${flashSuccess ? `<p class="hint" role="status">${escapeHtml(flashSuccess)}</p>` : ""}
        ${content}
      </main>
    </div>`;
}

function renderSetup() {
  return `<div class="auth"><section class="auth-hero"><div class="brand-mark"><div class="logo-tile">H</div>Hekp Gesk</div><div><h1>Seu help desk, compartilhado pela equipe.</h1><p>Conecte o projeto ao Supabase para habilitar autenticação e dados compartilhados.</p></div></section>
    <section class="auth-panel"><div class="card"><h2>Falta configurar a conexão</h2><p class="hint">Abra <b>config.js</b> e informe a URL do projeto Supabase e a chave publicável. Depois siga o README para criar as tabelas e o primeiro usuário administrador.</p><p class="hint">Use somente a chave publicável no navegador. Nunca coloque uma chave secreta ou service_role neste arquivo.</p></div></section></div>`;
}

function renderLoading() {
  return `<div class="auth"><section class="auth-panel"><div class="card"><h2>Conectando ao Hekp Gesk…</h2><p class="hint">Carregando sua conta e os chamados compartilhados.</p></div></section></div>`;
}

function renderLogin() {
  return `<div class="auth"><section class="auth-hero"><div class="brand-mark"><div class="logo-tile">H</div>Hekp Gesk</div><div><h1>Uma recepção digital para os quatro cantos do escritório.</h1><p>Abra chamados de TI, facilities, RH e suprimentos. Acompanhe status, prioridade e o escritório de origem.</p></div><div class="hero-meta"><span>Fila compartilhada</span><span>Histórico do chamado</span><span>Acesso por perfil</span></div></section>
    <section class="auth-panel"><form class="card" id="login-form"><h2>Entrar</h2><p class="hint">Use o e-mail e a senha fornecidos pelo administrador.</p>
      ${flashError ? `<p class="error" role="alert">${escapeHtml(flashError)}</p>` : ""}
      ${flashSuccess ? `<p class="hint" role="status">${escapeHtml(flashSuccess)}</p>` : ""}
      <div class="field"><label for="email">E-mail</label><input id="email" name="email" type="email" required autocomplete="username" placeholder="voce@empresa.com" /></div>
      <div class="field"><label for="password">Senha</label><input id="password" name="password" type="password" required autocomplete="current-password" /></div>
      <button class="btn full copper" type="submit">Acessar mesa</button>
      <p class="hint" style="margin:14px 0 0"><a href="#/forgot-password" data-go="/forgot-password">Esqueci minha senha</a></p>
    </form></section></div>`;
}

function renderForgotPassword() {
  return `<div class="auth"><section class="auth-panel"><form class="card" id="recovery-form"><h2>Recuperar acesso</h2><p class="hint">Informe o e-mail da sua conta. Enviaremos um link para criar uma nova senha.</p>
    ${flashError ? `<p class="error" role="alert">${escapeHtml(flashError)}</p>` : ""}
    ${flashSuccess ? `<p class="hint" role="status">${escapeHtml(flashSuccess)}</p>` : ""}
    <div class="field"><label for="recovery-email">E-mail</label><input id="recovery-email" name="email" type="email" required autocomplete="email" /></div>
    <button class="btn full copper" type="submit">Enviar link</button><p class="hint" style="margin:14px 0 0"><a href="#/login" data-go="/login">Voltar para entrar</a></p>
  </form></section></div>`;
}

function renderResetPassword() {
  return `<div class="auth"><section class="auth-panel"><form class="card" id="new-password-form"><h2>Criar nova senha</h2><p class="hint">Escolha uma senha com pelo menos 8 caracteres.</p>
    ${flashError ? `<p class="error" role="alert">${escapeHtml(flashError)}</p>` : ""}
    <div class="field"><label for="new-password">Nova senha</label><input id="new-password" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password" /></div>
    <div class="field"><label for="confirm-password">Repita a nova senha</label><input id="confirm-password" name="confirmPassword" type="password" required minlength="8" maxlength="72" autocomplete="new-password" /></div>
    <button class="btn full copper" type="submit">Salvar nova senha</button>
  </form></section></div>`;
}

function renderDashboard(user) {
  const tickets = visibleTickets(user);
  const openish = tickets.filter((ticket) => ["aberto", "andamento", "aguardando"].includes(ticket.status));
  const urgent = tickets.filter((ticket) => ticket.priority === "urgente" && ticket.status !== "encerrado");
  const mine = tickets.filter((ticket) => ticket.assigneeId === user.id && !["resolvido", "encerrado"].includes(ticket.status));
  const recent = tickets.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  return layout(user, "Painel", `<button class="btn copper" data-go="/new">Novo chamado</button>`, `
    <section class="kpis"><article class="kpi"><span>Abertos na fila</span><strong>${openish.length}</strong></article><article class="kpi"><span>Urgentes</span><strong>${urgent.length}</strong></article><article class="kpi"><span>Comigo</span><strong>${mine.length}</strong></article><article class="kpi"><span>Escritórios</span><strong>${state.offices.length}</strong></article></section>
    <section class="panel">${ticketTable(recent)}</section>`);
}

function ticketTable(tickets) {
  if (!tickets.length) return `<div class="empty">Nenhum chamado por aqui.</div>`;
  return `<table><thead><tr><th>Nº</th><th>Título</th><th>Escritório</th><th>Prioridade</th><th>Status</th><th>Atualizado</th></tr></thead><tbody>
    ${tickets.map((ticket) => `<tr class="clickable" data-go="/tickets/${ticket.id}"><td>${escapeHtml(ticket.number)}</td><td>${escapeHtml(ticket.title)}</td><td>${escapeHtml(officeById(ticket.officeId)?.city || "—")}</td><td>${badgePriority(ticket.priority)}</td><td>${badgeStatus(ticket.status)}</td><td>${formatDate(ticket.updatedAt)}</td></tr>`).join("")}
    </tbody></table>`;
}

function renderTickets(user) {
  const q = document.getElementById("q")?.value || "";
  const status = document.getElementById("status")?.value || "";
  const office = document.getElementById("office")?.value || "";
  let tickets = visibleTickets(user);
  const query = q.toLowerCase();
  if (query) tickets = tickets.filter((ticket) => ticket.title.toLowerCase().includes(query) || ticket.number.toLowerCase().includes(query) || ticket.category.toLowerCase().includes(query));
  if (status) tickets = tickets.filter((ticket) => ticket.status === status);
  if (office) tickets = tickets.filter((ticket) => ticket.officeId === office);
  return layout(user, "Chamados", `<button class="btn copper" data-go="/new">Abrir chamado</button>`, `
    <div class="filters"><input id="q" placeholder="Buscar por título, nº ou categoria" value="${escapeHtml(q)}" />
      <select id="status"><option value="">Todos os status</option>${STATUSES.map((value) => `<option value="${value}" ${status === value ? "selected" : ""}>${LABELS[value]}</option>`).join("")}</select>
      <select id="office"><option value="">Todos os escritórios</option>${state.offices.map((item) => `<option value="${item.id}" ${office === item.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select>
    </div><section class="panel">${ticketTable(tickets)}</section>`);
}

function renderNew(user) {
  const offices = user.role === "colaborador" ? state.offices.filter((item) => item.id === user.officeId) : state.offices;
  return layout(user, "Abrir chamado", "", `<form class="card" id="ticket-form" style="width:min(640px,100%)">
    <p class="hint">Descreva o problema e informe o escritório de origem.</p>
    <div class="field"><label for="title">Título</label><input id="title" name="title" required maxlength="90" placeholder="Ex.: Impressora da recepção sem papel" /></div>
    <div class="field"><label for="description">Descrição</label><textarea id="description" name="description" required placeholder="O que aconteceu, desde quando e quem foi afetado."></textarea></div>
    <div class="filters"><div class="field"><label>Categoria</label><select name="category">${CATEGORIES.map((value) => `<option>${value}</option>`).join("")}</select></div>
      <div class="field"><label>Prioridade</label><select name="priority">${PRIORITIES.map((value) => `<option value="${value}">${LABELS[value]}</option>`).join("")}</select></div>
      <div class="field"><label>Escritório</label><select name="officeId" ${user.role === "colaborador" ? "disabled" : ""}>${offices.map((item) => `<option value="${item.id}" ${item.id === user.officeId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select>
      ${user.role === "colaborador" ? `<input type="hidden" name="officeId" value="${escapeHtml(user.officeId)}" />` : ""}</div></div>
    <button class="btn copper" type="submit">Registrar chamado</button></form>`);
}

function renderTimeline(ticket) {
  const timeline = [
    ...ticket.comments.map((item) => ({ ...item, kind: "comment" })),
    ...ticket.events.map((item) => ({ ...item, kind: "event" })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!timeline.length) return `<div class="hint">Ainda não há atualizações.</div>`;
  return timeline.map((item) => `<div class="comment"><small>${escapeHtml(userById(item.authorId)?.name || (item.kind === "event" ? "Sistema" : "—"))} · ${formatDate(item.createdAt)}</small><div>${escapeHtml(item.body)}</div></div>`).join("");
}

function renderTicket(user) {
  const ticket = state.tickets.find((item) => item.id === route.id);
  if (!ticket) return layout(user, "Chamado", "", `<div class="empty">Chamado não encontrado.</div>`);
  const requester = userById(ticket.requesterId);
  const assignee = userById(ticket.assigneeId);
  return layout(user, ticket.number, `<button class="btn secondary" data-go="/tickets">Voltar à fila</button>`, `
    <div class="grid-2"><section class="detail"><h2 style="font-family:Fraunces,serif;margin:0 0 8px">${escapeHtml(ticket.title)}</h2><p>${escapeHtml(ticket.description)}</p><h3>Histórico</h3>
      <div class="comments">${renderTimeline(ticket)}</div><form id="comment-form"><div class="field"><label for="body">Nova atualização</label><textarea id="body" name="body" required placeholder="O que mudou?"></textarea></div><button class="btn" type="submit">Publicar</button></form>
    </section><aside class="detail"><dl class="meta-list"><div><span>Status</span>${badgeStatus(ticket.status)}</div><div><span>Prioridade</span>${badgePriority(ticket.priority)}</div><div><span>Categoria</span><span>${escapeHtml(ticket.category)}</span></div><div><span>Escritório</span><span>${escapeHtml(officeById(ticket.officeId)?.name || "—")}</span></div><div><span>Solicitante</span><span>${escapeHtml(requester?.name || "—")}</span></div><div><span>Atendente</span><span>${escapeHtml(assignee?.name || "Fila livre")}</span></div><div><span>Aberto</span><span>${formatDate(ticket.createdAt)}</span></div></dl>
      ${canManage(user) ? `<form id="manage-form" style="margin-top:18px"><div class="field"><label>Mover status</label><select name="status">${STATUSES.map((value) => `<option value="${value}" ${ticket.status === value ? "selected" : ""}>${LABELS[value]}</option>`).join("")}</select></div>
      <div class="field"><label>Prioridade</label><select name="priority">${PRIORITIES.map((value) => `<option value="${value}" ${ticket.priority === value ? "selected" : ""}>${LABELS[value]}</option>`).join("")}</select></div>
      <div class="field"><label>Atribuir</label><select name="assigneeId"><option value="">Fila livre</option>${state.users.filter((item) => item.role !== "colaborador").map((item) => `<option value="${item.id}" ${ticket.assigneeId === item.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></div>
      <button class="btn copper full" type="submit">Salvar triagem</button></form>` : ""}</aside></div>`);
}

function renderOffices(user) {
  return layout(user, "Escritórios", "", `<section class="offices">${state.offices.map((office) => {
    const count = state.tickets.filter((ticket) => ticket.officeId === office.id && ticket.status !== "encerrado").length;
    return `<article class="office-card"><h3>${escapeHtml(office.name)}</h3><p class="hint">${escapeHtml(office.address)}</p><div>${count} chamado(s) ativos</div></article>`;
  }).join("")}</section>${user.role === "admin" ? `<form class="card" id="office-form" style="margin-top:18px;width:min(520px,100%)"><h2>Novo escritório</h2><div class="field"><label>Nome</label><input name="name" required placeholder="Curitiba — Batel" /></div><div class="field"><label>Cidade</label><input name="city" required /></div><div class="field"><label>Endereço</label><input name="address" required /></div><button class="btn copper" type="submit">Adicionar</button></form>` : ""}`);
}

function renderUsers(user) {
  if (user.role !== "admin") return layout(user, "Equipe", "", `<div class="empty">Somente a administração pode cadastrar pessoas.</div>`);
  const teamRows = state.users.map((person) => `
    <tr><td>${escapeHtml(person.name)}</td><td>${LABELS[person.role] || escapeHtml(person.role)}</td><td>${escapeHtml(officeById(person.officeId)?.name || "—")}</td></tr>
  `).join("");
  return layout(user, "Equipe", "", `
    <div class="grid-2">
      <section class="panel">
        <h2>Usuários cadastrados</h2>
        ${teamRows ? `<table><thead><tr><th>Nome</th><th>Perfil</th><th>Escritório</th></tr></thead><tbody>${teamRows}</tbody></table>` : `<div class="empty">Ainda não há pessoas cadastradas.</div>`}
      </section>
      <form class="card" id="user-form">
        <h2>Cadastrar pessoa</h2>
        <p class="hint">A conta será vinculada ao escritório ${escapeHtml(officeById(user.officeId)?.name || "da administradora")}.</p>
        <div class="field"><label for="user-name">Nome</label><input id="user-name" name="name" required maxlength="100" autocomplete="name" /></div>
        <div class="field"><label for="user-email">E-mail de trabalho</label><input id="user-email" name="email" type="email" required maxlength="254" autocomplete="email" /></div>
        <div class="field"><label for="user-password">Senha inicial</label><input id="user-password" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password" /><small class="hint">Use pelo menos 8 caracteres e entregue a senha à pessoa por um canal seguro.</small></div>
        <div class="field"><label for="user-role">Perfil</label><select id="user-role" name="role"><option value="colaborador">Colaborador</option><option value="atendente">Atendente</option></select></div>
        <button class="btn copper full" type="submit">Criar conta</button>
      </form>
    </div>
  `);
}

function bind() {
  document.querySelectorAll("[data-go]").forEach((element) => element.addEventListener("click", () => go(element.getAttribute("data-go"))));
  document.getElementById("logout")?.addEventListener("click", logout);
  const loginForm = document.getElementById("login-form");
  loginForm?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(loginForm); login(String(data.get("email")), String(data.get("password")));
  });
  const userForm = document.getElementById("user-form");
  userForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(userForm);
    createEmployee({
      name: String(data.get("name")),
      email: String(data.get("email")),
      password: String(data.get("password")),
      role: String(data.get("role")),
    });
  });
  const recoveryForm = document.getElementById("recovery-form");
  recoveryForm?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(recoveryForm); sendPasswordRecovery(String(data.get("email")));
  });
  const newPasswordForm = document.getElementById("new-password-form");
  newPasswordForm?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(newPasswordForm);
    const password = String(data.get("password"));
    if (password !== String(data.get("confirmPassword"))) {
      flashError = "As senhas não são iguais.";
      render();
      return;
    }
    setNewPassword(password);
  });
  const ticketForm = document.getElementById("ticket-form");
  ticketForm?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(ticketForm);
    createTicket({ title: String(data.get("title")), description: String(data.get("description")), category: String(data.get("category")), priority: String(data.get("priority")), officeId: String(data.get("officeId")) });
  });
  const commentForm = document.getElementById("comment-form");
  commentForm?.addEventListener("submit", (event) => { event.preventDefault(); addComment(route.id, String(new FormData(commentForm).get("body"))); });
  const manageForm = document.getElementById("manage-form");
  manageForm?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(manageForm);
    updateTicket(route.id, { status: String(data.get("status")), priority: String(data.get("priority")), assigneeId: String(data.get("assigneeId")) || null });
  });
  const officeForm = document.getElementById("office-form");
  officeForm?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(officeForm);
    addOffice({ name: String(data.get("name")), city: String(data.get("city")), address: String(data.get("address")) });
  });
  ["q", "status", "office"].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("input", () => {
      const cursor = id === "q" ? element.selectionStart : null;
      render();
      if (id === "q") {
        const refreshed = document.getElementById("q");
        refreshed?.focus();
        if (cursor !== null) refreshed?.setSelectionRange(cursor, cursor);
      }
    });
    if (element?.tagName === "SELECT") element.addEventListener("change", () => render());
  });
}

function render() {
  const root = document.getElementById("app");
  route = parseHash();
  if (!window.supabase || !window.HEKP_SUPABASE || !window.HEKP_SUPABASE.url || !window.HEKP_SUPABASE.publishableKey) {
    root.innerHTML = renderSetup(); return;
  }
  if (loading) { root.innerHTML = renderLoading(); return; }
  if (route.name === "forgot-password") { root.innerHTML = renderForgotPassword(); bind(); return; }
  if (route.name === "reset-password") { root.innerHTML = renderResetPassword(); bind(); return; }
  const user = currentUser();
  if (!user) {
    root.innerHTML = renderLogin(); bind();
    return;
  }
  if (route.name === "tickets" && route.id) root.innerHTML = renderTicket(user);
  else if (route.name === "tickets") root.innerHTML = renderTickets(user);
  else if (route.name === "new") root.innerHTML = renderNew(user);
  else if (route.name === "offices") root.innerHTML = renderOffices(user);
  else if (route.name === "users") root.innerHTML = renderUsers(user);
  else if (route.name === "dashboard") root.innerHTML = renderDashboard(user);
  else { go("/dashboard"); return; }
  bind();
}

window.addEventListener("hashchange", () => { route = parseHash(); flashError = ""; flashSuccess = ""; render(); });

async function boot() {
  if (!window.supabase || !window.HEKP_SUPABASE?.url || !window.HEKP_SUPABASE?.publishableKey) { loading = false; render(); return; }
  try {
    db = window.supabase.createClient(window.HEKP_SUPABASE.url, window.HEKP_SUPABASE.publishableKey);
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    if (data.session) await loadWorkspace();
    else { loading = false; render(); }
    db.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        state = { user: null, offices: [], users: [], tickets: [] }; loading = false; render();
      }
    });
  } catch (error) { showError(error); }
}

render();
boot();
