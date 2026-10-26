const CATEGORIES = ["TI", "Infraestrutura", "Financeiro"];
const CATEGORY_LABELS = {
  TI: "TI — cabos, periféricos, computadores e internet",
  Infraestrutura: "Infraestrutura — estrutura física, cadeiras, mesas e ar-condicionado",
  Financeiro: "Financeiro — assuntos do departamento",
};
const PRIORITIES = ["baixa", "media", "alta", "urgente"];
const STATUSES = ["aberto", "andamento", "aguardando", "resolvido", "encerrado"];
const WORKFLOW_STEPS = ["triagem", "orcamento", "financeiro", "execucao", "resolvido"];
const BOOKING_TIME_ZONE = "America/Sao_Paulo";
const BOOKING_DURATIONS = [30, 60, 90, 120];
const LABELS = {
  baixa: "Baixa", media: "Média", alta: "Alta", urgente: "Urgente",
  aberto: "Aberto", andamento: "Em andamento", aguardando: "Aguardando",
  resolvido: "Resolvido", encerrado: "Encerrado",
  colaborador: "Colaborador", atendente: "Atendente", admin: "Administração", coordenador: "Coordenador",
  financeiro: "Financeiro",
  triagem: "Aguardando responsável", orcamento: "Contato e orçamento", financeiro_etapa: "Aprovação financeira",
  execucao: "Execução do serviço", fluxo_resolvido: "Fluxo resolvido",
};

let db = null;
let state = { user: null, users: [], tickets: [], rooms: [], bookings: [], busy: [], notifications: [], reservationsReady: false };
let reservationDate = dateInBookingZone();
let reservationDuration = 60;
let reservationOfficeId = null;
let adminBookingQuery = "";
let adminBookingLawyerId = "";
let selectedSlot = null;
let availabilityRequest = 0;
let notificationPoll = null;
let route = parseHash();
let flashError = "";
let flashSuccess = "";
let keepSuccessOnNavigation = false;
let loading = true;

function parseHash() {
  if (new URLSearchParams(location.search).has("auth-recovery")) return { name: "reset-password", id: null };
  const parts = (location.hash || "#/login").replace(/^#/, "").split("/").filter(Boolean);
  return { name: parts[0] || "login", id: parts[1] || null };
}

function go(path, keepSuccess = false) {
  keepSuccessOnNavigation = keepSuccess;
  location.hash = path;
}
function now() { return new Date().toISOString(); }
function formatDate(value) {
  return new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function bookingParts(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BOOKING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}
function dateInBookingZone(value = new Date()) {
  const part = bookingParts(value);
  return `${part.year}-${part.month}-${part.day}`;
}
function bookingLocalToIso(date, time) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const part = bookingParts(new Date(instant));
    const observed = Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day), Number(part.hour), Number(part.minute));
    instant += target - observed;
  }
  const part = bookingParts(new Date(instant));
  if (`${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}` !== `${date} ${time}`) {
    throw new Error("Horário inválido para o fuso de Brasília.");
  }
  return new Date(instant).toISOString();
}
function bookingTime(value) {
  const part = bookingParts(new Date(value));
  return `${part.hour}:${part.minute}`;
}
function bookingDateTime(value) {
  const date = new Date(value);
  return `${dateInBookingZone(date).split("-").reverse().join("/")} ${bookingTime(value)}`;
}
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function currentUser() { return state.user; }
function userById(id) { return state.users.find((user) => user.id === id); }
function canAdminister(user) { return user?.role === "admin" || user?.role === "coordenador"; }
function canEditTicket(user, ticket) { return canAdminister(user) || ticket?.assigneeId === user?.id || ticket?.workflowOwnerId === user?.id; }
function visibleTickets(user) {
  return state.tickets.slice();
}
function checkError(result) {
  if (result.error) throw result.error;
  return result.data;
}

function mapUser(row) { return { id: row.id, name: row.name, role: row.role, officeId: row.office_id }; }
function mapTicket(row) {
  return {
    id: row.id, number: `HD-${row.ticket_no}`, title: row.title, description: row.description,
    category: row.category, priority: row.priority, status: row.status, officeId: row.office_id,
    location: row.location || "",
    requesterId: row.requester_id, assigneeId: row.assignee_id, workflowOwnerId: row.workflow_owner_id,
    financialAssigneeId: row.financial_assignee_id, workflowStep: row.workflow_step || "triagem",
    budgetAmount: row.budget_amount, financeDecision: row.finance_decision || "pendente",
    financeNote: row.finance_note || "", createdAt: row.created_at,
    updatedAt: row.updated_at, comments: [], events: [],
    attachments: [],
  };
}

async function refreshNotifications() {
  if (!state.user || !db) return;
  const result = await db.from("notifications").select("id,ticket_id,title,body,created_at,read_at").order("created_at", { ascending: false }).limit(30);
  if (result.error) return;
  const next = result.data || [];
  if (JSON.stringify(next) !== JSON.stringify(state.notifications || [])) {
    state.notifications = next;
    render();
  }
}
function mapRoom(row) {
  return { id: row.id, officeId: row.office_id, name: row.name, capacity: row.capacity, active: row.active };
}
function mapBooking(row) {
  return { id: row.id, roomId: row.room_id, organizerId: row.organizer_id,
    clientName: row.client_name, subject: row.subject, startsAt: row.starts_at,
    endsAt: row.ends_at, canceledAt: row.canceled_at };
}

function resetReservationSession() {
  reservationDate = dateInBookingZone();
  reservationDuration = 60;
  reservationOfficeId = null;
  adminBookingQuery = "";
  adminBookingLawyerId = "";
  selectedSlot = null;
  availabilityRequest += 1;
}

async function loadWorkspace() {
  const { data: authData, error: authError } = await db.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) {
    state = { user: null, users: [], tickets: [], rooms: [], bookings: [], busy: [], notifications: [], reservationsReady: false };
    resetReservationSession();
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
  const [userRows, ticketRows, commentRows, eventRows, attachmentRows, notificationRows] = await Promise.all([
    db.from("profiles").select("id,name,role,office_id").order("name"),
    db.from("tickets").select("id,ticket_no,title,description,category,priority,status,office_id,location,requester_id,assignee_id,workflow_owner_id,financial_assignee_id,workflow_step,budget_amount,finance_decision,finance_note,created_at,updated_at").order("updated_at", { ascending: false }),
    db.from("ticket_comments").select("id,ticket_id,author_id,body,created_at").order("created_at"),
    db.from("ticket_events").select("id,ticket_id,actor_id,body,created_at").order("created_at"),
    db.from("ticket_attachments").select("id,ticket_id,file_name,file_path,mime_type,file_size,created_at,uploader_id").order("created_at"),
    db.from("notifications").select("id,ticket_id,title,body,created_at,read_at").order("created_at", { ascending: false }).limit(30),
  ]);
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
  for (const row of checkError(attachmentRows)) {
    const ticket = state.tickets.find((item) => item.id === row.ticket_id);
    if (ticket) ticket.attachments.push({ id: row.id, fileName: row.file_name, filePath: row.file_path, mimeType: row.mime_type, fileSize: row.file_size, createdAt: row.created_at, uploaderId: row.uploader_id });
  }
  state.notifications = checkError(notificationRows);
  state.user = mapUser(profile);
  if (!reservationOfficeId) reservationOfficeId = state.user.officeId;
  await loadReservationData();
  loading = false;
  render();
}

function missingReservationSchema(error) {
  return ["42P01", "PGRST205", "PGRST202"].includes(error?.code);
}

async function loadReservationData() {
  const roomsResult = await db.from("meeting_rooms").select("id,office_id,name,capacity,active").order("name");
  if (roomsResult.error) {
    if (!missingReservationSchema(roomsResult.error)) throw roomsResult.error;
    state.rooms = [];
    state.bookings = [];
    state.busy = [];
    state.reservationsReady = false;
    return;
  }
  state.rooms = checkError(roomsResult).map(mapRoom);
  const bookings = [];
  const futureFrom = new Date().toISOString();
  for (let offset = 0; ; offset += 1000) {
    const bookingsResult = await db.from("room_bookings")
      .select("id,room_id,organizer_id,client_name,subject,starts_at,ends_at,canceled_at")
      .gte("ends_at", futureFrom)
      .order("starts_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (bookingsResult.error && missingReservationSchema(bookingsResult.error)) {
      state.reservationsReady = false;
      state.bookings = [];
      state.busy = [];
      return;
    }
    const page = checkError(bookingsResult);
    bookings.push(...page.map(mapBooking));
    if (page.length < 1000) break;
  }
  state.bookings = bookings;
  state.reservationsReady = true;
  await loadAvailability(reservationDate, false);
}

async function loadAvailability(date, shouldRender = true) {
  const request = ++availabilityRequest;
  const nextDate = new Date(`${date}T12:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextDay = nextDate.toISOString().slice(0, 10);
  const result = await db.rpc("room_busy_slots", {
    p_start: bookingLocalToIso(date, "00:00"),
    p_end: bookingLocalToIso(nextDay, "00:00"),
  });
  if (result.error) {
    if (missingReservationSchema(result.error)) {
      state.reservationsReady = false;
      state.busy = [];
    } else if (shouldRender && request === availabilityRequest) showError(result.error);
    else throw result.error;
  } else if (request === availabilityRequest) {
    state.busy = result.data || [];
  }
  if (shouldRender && request === availabilityRequest) render();
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
  } catch (error) {
    const message = error?.message || "Não foi possível concluir a autenticação.";
    showError(new Error(`Falha ao autenticar no Supabase: ${message}`));
    return;
  }

  try {
    await loadWorkspace();
  } catch (error) {
    const message = error?.message || "Não foi possível carregar os dados do sistema.";
    showError(new Error(`Autenticação concluída, mas falhou ao carregar os dados do Help Desk: ${message}`));
    return;
  }

  if (state.user) go("/tickets");
}

async function logout() {
  const { error } = await db.auth.signOut();
  if (error) return showError(error);
  state = { user: null, users: [], tickets: [], rooms: [], bookings: [], busy: [], reservationsReady: false };
  resetReservationSession();
  flashError = "";
  go("/login");
  render();
}

async function createTicket(payload) {
  const user = currentUser();
  const assigneeId = payload.assigneeId || null;
  try {
    const result = await db.from("tickets").insert({
      title: payload.title.trim(), description: payload.description.trim(), category: payload.category,
      priority: payload.priority, office_id: user.officeId, location: payload.location.trim() || null,
      requester_id: user.id, assignee_id: assigneeId, workflow_owner_id: assigneeId,
    }).select("id").single();
    const ticket = checkError(result);
    await loadWorkspace();
    go(`/tickets/${ticket.id}`);
  } catch (error) { showError(error); }
}

async function updateTicket(id, patch) {
  const row = {};
  if (Object.hasOwn(patch, "status")) row.status = patch.status;
  if (Object.hasOwn(patch, "priority")) row.priority = patch.priority;
  if (Object.hasOwn(patch, "assigneeId")) row.assignee_id = patch.assigneeId || null;
  if (Object.hasOwn(patch, "workflowOwnerId")) row.workflow_owner_id = patch.workflowOwnerId || null;
  if (Object.hasOwn(patch, "financialAssigneeId")) row.financial_assignee_id = patch.financialAssigneeId || null;
  try {
    checkError(await db.from("tickets").update(row).eq("id", id).select("id").single());
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function submitQuoteForApproval(id, amount, file) {
  const ticket = state.tickets.find((item) => item.id === id);
  if (!ticket?.workflowOwnerId || !ticket.financialAssigneeId) return showError(new Error("Atribua Andreza e uma pessoa do Financeiro antes de encaminhar o orçamento."));
  const parsedAmount = Number(String(amount).replace(",", "."));
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) return showError(new Error("Informe um valor de orçamento válido."));
  if (!file) return showError(new Error("Anexe o orçamento recebido do Thomas."));
  if (file.size > 10 * 1024 * 1024) return showError(new Error("O arquivo deve ter no máximo 10 MB."));
  flashError = "";
  try {
    const filePath = `${id}/${crypto.randomUUID()}-${file.name.replace(/[^\p{L}\p{N}._-]/gu, "_")}`;
    checkError(await db.storage.from("ticket-files").upload(filePath, file, { contentType: file.type || "application/octet-stream", upsert: false }));
    checkError(await db.from("ticket_attachments").insert({ ticket_id: id, uploader_id: currentUser().id, file_name: file.name, file_path: filePath, mime_type: file.type || "application/octet-stream", file_size: file.size }));
    checkError(await db.from("tickets").update({ workflow_step: "financeiro", status: "aguardando", budget_amount: parsedAmount, finance_decision: "pendente", finance_note: "", assignee_id: ticket.financialAssigneeId }).eq("id", id).select("id").single());
    flashSuccess = "Orçamento encaminhado ao Financeiro.";
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function decideQuote(id, approved, note) {
  const ticket = state.tickets.find((item) => item.id === id);
  if (!ticket) return;
  const decision = approved ? "aprovado" : "rejeitado";
  if (!approved && !note.trim()) return showError(new Error("Informe o motivo da rejeição para Andreza."));
  try {
    checkError(await db.from("tickets").update({
      workflow_step: approved ? "execucao" : "orcamento",
      status: approved ? "andamento" : "aguardando",
      finance_decision: decision,
      finance_note: note.trim(),
      assignee_id: ticket.workflowOwnerId,
    }).eq("id", id).select("id").single());
    flashSuccess = approved ? "Orçamento aprovado e devolvido à Andreza para combinar o serviço." : "Orçamento rejeitado e devolvido à Andreza.";
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function completeWorkflowTicket(id) {
  try {
    checkError(await db.from("tickets").update({ workflow_step: "resolvido", status: "resolvido" }).eq("id", id).select("id").single());
    flashSuccess = "Chamado marcado como resolvido.";
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function startWorkflowTicket(id) {
  const ticket = state.tickets.find((item) => item.id === id);
  if (!ticket?.workflowOwnerId) return showError(new Error("Atribua Andreza como responsável pelo fluxo primeiro."));
  try {
    checkError(await db.from("tickets").update({ workflow_step: "orcamento", status: "andamento", assignee_id: ticket.workflowOwnerId }).eq("id", id).select("id").single());
    flashSuccess = "Chamado atribuído à Andreza para contato com Thomas.";
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function markNotificationRead(id) {
  try {
    checkError(await db.from("notifications").update({ read_at: now() }).eq("id", id).is("read_at", null));
    state.notifications = state.notifications.map((item) => item.id === id ? { ...item, read_at: now() } : item);
    render();
  } catch (error) { showError(error); }
}

async function openAttachment(filePath) {
  try {
    const { data, error } = await db.storage.from("ticket-files").createSignedUrl(filePath, 60);
    if (error) throw error;
    location.assign(data.signedUrl);
  } catch (error) { showError(error); }
}

async function addComment(id, body) {
  if (!body.trim()) return;
  try {
    checkError(await db.from("ticket_comments").insert({ ticket_id: id, author_id: currentUser().id, body: body.trim() }));
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function addRoom(payload) {
  try {
    checkError(await db.from("meeting_rooms").insert({
      office_id: currentUser().officeId, name: payload.name.trim(), capacity: Number(payload.capacity),
    }));
    flashSuccess = "Sala cadastrada.";
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function setRoomActive(id, active) {
  try {
    checkError(await db.from("meeting_rooms").update({ active }).eq("id", id).select("id").single());
    flashSuccess = active ? "Sala ativada." : "Sala desativada para novas reservas.";
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function createBooking(payload) {
  try {
    const start = bookingLocalToIso(payload.date, payload.time);
    const end = new Date(new Date(start).getTime() + Number(payload.duration) * 60000).toISOString();
    if (new Date(start).getTime() <= Date.now()) throw new Error("Escolha um horário futuro.");
    if (dateInBookingZone(new Date(end)) !== payload.date || bookingTime(end) > "18:00") {
      throw new Error("A reunião precisa terminar até 18:00 no horário de Brasília.");
    }
    checkError(await db.from("room_bookings").insert({
      room_id: payload.roomId, organizer_id: currentUser().id,
      client_name: payload.clientName.trim(), subject: payload.subject.trim(),
      starts_at: start, ends_at: end,
    }));
    selectedSlot = null;
    reservationDate = payload.date;
    flashSuccess = "Sala reservada com sucesso.";
    await loadWorkspace();
    go("/reservations", true);
  } catch (error) {
    if (error?.code === "23P01") showError(new Error("Este horário acabou de ser reservado. Escolha outro horário."));
    else showError(error);
  }
}

async function cancelBooking(id) {
  try {
    checkError(await db.from("room_bookings").update({ canceled_at: new Date().toISOString() }).eq("id", id).select("id").single());
    flashSuccess = "Reserva cancelada.";
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function updateBooking(id, payload) {
  try {
    const start = bookingLocalToIso(payload.date, payload.time);
    const end = new Date(new Date(start).getTime() + Number(payload.duration) * 60000).toISOString();
    if (new Date(start).getTime() <= Date.now()) throw new Error("Escolha um horário futuro.");
    if (dateInBookingZone(new Date(end)) !== payload.date || bookingTime(end) > "18:00") {
      throw new Error("A reunião precisa terminar até 18:00 no horário de Brasília.");
    }
    checkError(await db.from("room_bookings").update({
      room_id: payload.roomId, client_name: payload.clientName.trim(), subject: payload.subject.trim(),
      starts_at: start, ends_at: end,
    }).eq("id", id).select("id").single());
    reservationDate = payload.date;
    flashSuccess = "Reserva atualizada.";
    await loadWorkspace();
    go("/reservations", true);
  } catch (error) {
    if (error?.code === "23P01") showError(new Error("Este horário acabou de ser reservado. Escolha outro horário."));
    else showError(error);
  }
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
    state = { user: null, users: [], tickets: [], rooms: [], bookings: [], busy: [], reservationsReady: false };
    resetReservationSession();
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
    const { data, error } = await db.functions.invoke("create-user", { body: payload });
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

async function deleteEmployee(userId) {
  const employee = userById(userId);
  if (!employee || employee.id === state.user?.id || canAdminister(employee)) return;
  const confirmed = window.confirm(`Excluir a conta de ${employee.name}? A pessoa perderá o acesso. Chamados, comentários e reservas serão mantidos no histórico, sem vínculo com essa conta.`);
  if (!confirmed) return;

  flashError = "";
  flashSuccess = "";
  try {
    const { data, error } = await db.functions.invoke("delete-user", { body: { userId } });
    if (error) {
      let message = error.message;
      try {
        const response = await error.context.json();
        message = response.error || message;
      } catch { /* Keep the SDK's message when the response has no JSON body. */ }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    flashSuccess = `A conta de ${employee.name} foi excluída. O histórico foi mantido.`;
    await loadWorkspace();
  } catch (error) { showError(error); }
}

async function updateEmployeeRole(userId, role) {
  try {
    const { data, error } = await db.functions.invoke("update-user", { body: { userId, role } });
    if (error) {
      let message = error.message;
      try {
        const response = await error.context.json();
        message = response.error || message;
      } catch { /* Keep the SDK's message when the response has no JSON body. */ }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    flashSuccess = "Perfil atualizado.";
    await loadWorkspace();
  } catch (error) { showError(error); }
}

function badgeStatus(status) { return `<span class="badge st-${escapeHtml(status)}">${LABELS[status] || escapeHtml(status)}</span>`; }
function badgePriority(priority) { return `<span class="badge pr-${escapeHtml(priority)}">${LABELS[priority] || escapeHtml(priority)}</span>`; }

function layout(user, title, actions, content) {
  const unreadNotifications = (state.notifications || []).filter((item) => !item.read_at);
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand-mark" style="margin:4px 8px 22px"><div class="logo-tile">H</div>Hekp Gesk</div>
        <button class="nav-btn ${route.name === "tickets" && !route.id ? "active" : ""}" data-go="/tickets">Chamados</button>
        <button class="nav-btn ${route.name === "new" ? "active" : ""}" data-go="/new">Abrir chamado</button>
        <button class="nav-btn ${route.name === "reservations" || route.name === "booking" ? "active" : ""}" data-go="/reservations">Reservas de salas</button>
        ${canAdminister(user) ? `<button class="nav-btn ${route.name === "users" ? "active" : ""}" data-go="/users">Equipe</button>` : ""}
        <div class="user-box"><strong>${escapeHtml(user.name)}</strong><br />${LABELS[user.role]}
          <button type="button" id="logout">Sair</button>
        </div>
      </aside>
      <main class="main">
        <div class="topbar"><div><div class="hint" style="margin:0 0 4px">Help Desk</div><h1>${escapeHtml(title)}</h1></div><div>${actions || ""}</div></div>
        ${(state.notifications || []).length ? `<section class="notification-panel"><strong>Notificações${unreadNotifications.length ? ` · ${unreadNotifications.length} nova(s)` : ""}</strong><div>${state.notifications.slice(0, 5).map((item) => `<button class="notification-item ${item.read_at ? "" : "unread"}" type="button" data-notification-id="${escapeHtml(item.id)}" data-notification-ticket="${escapeHtml(item.ticket_id)}"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(item.body)} · ${formatDate(item.created_at)}</small></button>`).join("")}</div></section>` : ""}
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
  return `<div class="auth"><section class="auth-hero"><div class="brand-mark"><div class="logo-tile">H</div>Hekp Gesk</div><div><h1>Uma recepção digital para sua equipe.</h1><p>Abra chamados, acompanhe o fluxo de atendimento e receba atualizações em um só lugar.</p></div><div class="hero-meta"><span>Fila compartilhada</span><span>Histórico do chamado</span><span>Acesso por perfil</span></div></section>
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

function roomById(id) { return state.rooms.find((room) => room.id === id); }

function availableStarts(room, date, duration) {
  const starts = [];
  for (let minute = 8 * 60; minute + duration <= 18 * 60; minute += 30) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const start = new Date(bookingLocalToIso(date, time)).getTime();
    const end = start + duration * 60000;
    if (start <= Date.now()) continue;
    const occupied = state.busy.some((slot) => slot.room_id === room.id &&
      new Date(slot.starts_at).getTime() < end && new Date(slot.ends_at).getTime() > start);
    if (!occupied) starts.push(time);
  }
  return starts;
}

function renderAvailability(user, compact = false) {
  if (!state.reservationsReady) {
    return `<section class="card booking-setup"><h2>Reservas de salas</h2><p class="hint">O módulo estará disponível após aplicar a migração do Supabase.</p></section>`;
  }
  const rooms = state.rooms.filter((room) => room.active && room.officeId === reservationOfficeId);
  return `<section class="booking-section">
    <div class="booking-head"><div><h2>Horários disponíveis</h2><p class="hint">Horário de Brasília · reuniões entre 08:00 e 18:00</p></div>
      <div class="booking-actions"><button class="btn secondary" id="refresh-bookings" type="button">Atualizar horários</button>${compact ? `<button class="btn secondary" data-go="/reservations">Ver agenda completa</button>` : ""}</div></div>
    <div class="filters booking-filters">
      <div class="field"><label for="booking-date">Data</label><input id="booking-date" type="date" min="${dateInBookingZone()}" value="${reservationDate}" /></div>
      <div class="field"><label for="booking-duration">Duração</label><select id="booking-duration">${BOOKING_DURATIONS.map((value) => `<option value="${value}" ${value === reservationDuration ? "selected" : ""}>${value} min</option>`).join("")}</select></div>
    </div>
    ${rooms.length ? `<div class="room-grid">${rooms.map((room) => {
      const starts = availableStarts(room, reservationDate, reservationDuration);
      const shown = compact ? starts.slice(0, 8) : starts;
      return `<article class="room-card"><div class="room-title"><h3>${escapeHtml(room.name)}</h3><span>${room.capacity} lugares</span></div>
        ${starts.length ? `<div class="slot-grid">${shown.map((time) => `<button type="button" class="slot-button" data-slot-room="${room.id}" data-slot-time="${time}">${time}</button>`).join("")}</div>${compact && starts.length > shown.length ? `<p class="hint">Mais ${starts.length - shown.length} horários na agenda completa.</p>` : ""}` : `<p class="hint">Sem horários livres nesta data.</p>`}
      </article>`;
    }).join("")}</div>` : `<div class="empty">Ainda não há salas ativas cadastradas.</div>`}
  </section>`;
}

function renderBookingForm(user) {
  if (!selectedSlot) return layout(user, "Nova reserva", "", `<div class="empty">Selecione um horário na agenda para reservar.</div><button class="btn secondary" data-go="/reservations">Ver horários</button>`);
  const room = roomById(selectedSlot.roomId);
  if (!room || !room.active) return layout(user, "Nova reserva", "", `<div class="empty">Sala indisponível. Escolha outro horário.</div>`);
  return layout(user, "Confirmar reserva", `<button class="btn secondary" data-go="/reservations">Voltar à agenda</button>`, `
    <form id="booking-form" class="card booking-form">
      <h2>${escapeHtml(room.name)}</h2><p class="hint">${selectedSlot.date.split("-").reverse().join("/")} às ${selectedSlot.time} · ${selectedSlot.duration} min · horário de Brasília</p>
      <div class="field"><label for="client-name">Cliente</label><input id="client-name" name="clientName" required maxlength="120" autocomplete="off" /></div>
      <div class="field"><label for="meeting-subject">Assunto</label><input id="meeting-subject" name="subject" required maxlength="160" /></div>
      <button class="btn copper" type="submit">Confirmar reserva</button>
    </form>`);
}

function renderBookingEditor(user) {
  const booking = state.bookings.find((item) => item.id === route.id);
  if (!booking || (booking.organizerId !== user.id && !canAdminister(user)) || new Date(booking.startsAt).getTime() <= Date.now()) {
    return layout(user, "Editar reserva", "", `<div class="empty">Reserva indisponível para edição.</div><button class="btn secondary" data-go="/reservations">Voltar à agenda</button>`);
  }
  const room = roomById(booking.roomId);
  const date = dateInBookingZone(new Date(booking.startsAt));
  const duration = Math.round((new Date(booking.endsAt) - new Date(booking.startsAt)) / 60000);
  return layout(user, "Editar reserva", `<button class="btn secondary" data-go="/reservations">Voltar à agenda</button>`, `
    <form id="booking-edit-form" class="card booking-form">
      <h2>${escapeHtml(room?.name || "Sala")}</h2>
      <div class="field"><label for="edit-booking-room">Sala</label><select id="edit-booking-room" name="roomId" required>${state.rooms.filter((item) => item.active && item.officeId === room?.officeId || item.id === booking.roomId).map((item) => `<option value="${item.id}" ${item.id === booking.roomId ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></div>
      <div class="field"><label for="edit-booking-date">Data</label><input id="edit-booking-date" name="date" type="date" min="${dateInBookingZone()}" value="${date}" required /></div>
      <div class="field"><label for="edit-booking-time">Horário</label><input id="edit-booking-time" name="time" type="time" min="08:00" max="17:30" step="1800" value="${bookingTime(booking.startsAt)}" required /></div>
      <div class="field"><label for="edit-booking-duration">Duração</label><select id="edit-booking-duration" name="duration">${BOOKING_DURATIONS.map((value) => `<option value="${value}" ${value === duration ? "selected" : ""}>${value} min</option>`).join("")}</select></div>
      <div class="field"><label for="edit-booking-client">Cliente</label><input id="edit-booking-client" name="clientName" required maxlength="120" value="${escapeHtml(booking.clientName)}" /></div>
      <div class="field"><label for="edit-booking-subject">Assunto</label><input id="edit-booking-subject" name="subject" required maxlength="160" value="${escapeHtml(booking.subject)}" /></div>
      <button class="btn copper" type="submit">Salvar alterações</button>
    </form>`);
}

function renderReservations(user) {
  if (!state.reservationsReady) return layout(user, "Reservas de salas", "", renderAvailability(user));
  const upcoming = state.bookings.filter((booking) => !booking.canceledAt && new Date(booking.endsAt).getTime() > Date.now());
  const visible = upcoming;
  const adminVisible = canAdminister(user) ? upcoming.filter((booking) =>
    (!adminBookingLawyerId || booking.organizerId === adminBookingLawyerId)
    && (!adminBookingQuery || `${booking.clientName} ${booking.subject}`.toLocaleLowerCase("pt-BR").includes(adminBookingQuery.toLocaleLowerCase("pt-BR")))) : upcoming;
  const adminSummary = canAdminister(user) ? (() => {
    const counts = new Map();
    for (const booking of upcoming) {
      const key = `${booking.organizerId}\u0000${booking.clientName.toLocaleLowerCase("pt-BR")}`;
      const previous = counts.get(key);
      if (previous) previous.count += 1;
      else counts.set(key, { organizerId: booking.organizerId, clientName: booking.clientName, count: 1 });
    }
    const summaryRows = [...counts.values()].sort((a, b) => b.count - a.count)
      .map((item) => `<tr><td>${escapeHtml(userById(item.organizerId)?.name || "—")}</td><td>${escapeHtml(item.clientName)}</td><td>${item.count}</td></tr>`).join("");
    return `<section class="booking-section"><h2>Reuniões por advogado e cliente</h2><div class="panel table-scroll">${summaryRows ? `<table><thead><tr><th>Advogado</th><th>Cliente</th><th>Reuniões futuras</th></tr></thead><tbody>${summaryRows}</tbody></table>` : `<div class="empty">Nenhuma reunião futura.</div>`}</div></section>`;
  })() : "";
  const adminFilters = canAdminister(user) ? `<div class="filters booking-list-filters">
    <input id="booking-search" placeholder="Buscar cliente ou assunto" value="${escapeHtml(adminBookingQuery)}" />
    <select id="booking-lawyer"><option value="">Todos os advogados</option>${state.users.map((person) => `<option value="${person.id}" ${adminBookingLawyerId === person.id ? "selected" : ""}>${escapeHtml(person.name)}</option>`).join("")}</select>
  </div>` : "";
  const rows = (canAdminister(user) ? adminVisible : visible).map((booking) => {
    const room = roomById(booking.roomId);
    return `<tr><td>${bookingDateTime(booking.startsAt)}–${bookingTime(booking.endsAt)}</td><td>${escapeHtml(room?.name || "—")}</td>
      <td>${escapeHtml(userById(booking.organizerId)?.name || "—")}</td>
      <td>${escapeHtml(booking.clientName)}</td><td>${escapeHtml(booking.subject)}</td>
      <td>${new Date(booking.startsAt).getTime() > Date.now() && (booking.organizerId === user.id || canAdminister(user)) ? `<button class="btn secondary small-btn" data-edit-booking="${booking.id}">Editar</button> <button class="btn secondary small-btn" data-cancel-booking="${booking.id}">Cancelar</button>` : "Em andamento"}</td></tr>`;
  }).join("");
  const roomAdmin = canAdminister(user) ? `<section class="booking-section"><h2>Salas cadastradas</h2>
    <div class="room-list">${state.rooms.map((room) => `<div><span><strong>${escapeHtml(room.name)}</strong> · ${room.capacity} lugares ${room.active ? "" : "· inativa"}</span><button type="button" class="btn secondary small-btn" data-room-toggle="${room.id}" data-room-active="${room.active ? "false" : "true"}">${room.active ? "Desativar" : "Ativar"}</button></div>`).join("") || "Nenhuma sala cadastrada."}</div>
    <form id="room-form" class="room-form"><div class="field"><label>Nome da sala</label><input name="name" required maxlength="80" placeholder="Ex.: Sala 1" /></div>
      <div class="field"><label>Lugares</label><input name="capacity" type="number" min="1" max="100" value="4" required /></div>
      <button class="btn copper" type="submit">Cadastrar sala</button></form></section>` : "";
  return layout(user, "Reservas de salas", "", `${renderAvailability(user)}
    <section class="booking-section"><div class="booking-head"><h2>Reuniões agendadas</h2><span class="booking-count">${(canAdminister(user) ? adminVisible : visible).length} agendada(s)</span></div>
      ${adminFilters}
      <div class="panel table-scroll">${rows ? `<table><thead><tr><th>Data e horário</th><th>Sala</th><th>Organizador</th><th>Cliente</th><th>Assunto</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">Nenhuma reunião agendada.</div>`}</div></section>
    ${adminSummary}
    ${roomAdmin}`);
}

function ticketTable(tickets) {
  if (!tickets.length) return `<div class="empty">Nenhum chamado por aqui.</div>`;
  return `<table><thead><tr><th>Nº</th><th>Título</th><th>Prioridade</th><th>Status</th><th>Atualizado</th></tr></thead><tbody>
    ${tickets.map((ticket) => `<tr class="clickable" data-go="/tickets/${ticket.id}"><td>${escapeHtml(ticket.number)}</td><td>${escapeHtml(ticket.title)}</td><td>${badgePriority(ticket.priority)}</td><td>${badgeStatus(ticket.status)}</td><td>${formatDate(ticket.updatedAt)}</td></tr>`).join("")}
    </tbody></table>`;
}

function renderTickets(user) {
  const q = document.getElementById("q")?.value || "";
  const status = document.getElementById("status")?.value || "";
  let tickets = visibleTickets(user);
  const query = q.toLowerCase();
  if (query) tickets = tickets.filter((ticket) => ticket.title.toLowerCase().includes(query) || ticket.number.toLowerCase().includes(query) || ticket.category.toLowerCase().includes(query));
  if (status) tickets = tickets.filter((ticket) => ticket.status === status);
  return layout(user, "Chamados", `<button class="btn copper" data-go="/new">Abrir chamado</button>`, `
    <div class="filters"><input id="q" placeholder="Buscar por título, nº ou categoria" value="${escapeHtml(q)}" />
      <select id="status"><option value="">Todos os status</option>${STATUSES.map((value) => `<option value="${value}" ${status === value ? "selected" : ""}>${LABELS[value]}</option>`).join("")}</select>
    </div><section class="panel">${ticketTable(tickets)}</section>`);
}

function renderNew(user) {
  const assignees = state.users.filter((item) => ["atendente", "coordenador", "admin"].includes(item.role));
  return layout(user, "Abrir chamado", "", `<form class="card" id="ticket-form" style="width:min(640px,100%)">
    <p class="hint">TI para cabos, periféricos e falhas de tecnologia; Infraestrutura para a estrutura física, como cadeiras, mesas e ar-condicionado; Financeiro para assuntos do departamento.</p>
    <div class="field"><label for="title">Título</label><input id="title" name="title" required maxlength="90" placeholder="Ex.: Impressora da recepção sem papel" /></div>
    <div class="field"><label for="description">Descrição</label><textarea id="description" name="description" required placeholder="O que aconteceu, desde quando e quem foi afetado."></textarea></div>
    <div class="field"><label for="location">Local (opcional)</label><input id="location" name="location" maxlength="120" placeholder="Ex.: sala de reuniões ou mesa 12" /></div>
    <div class="filters"><div class="field"><label>Categoria</label><select name="category">${CATEGORIES.map((value) => `<option value="${value}">${CATEGORY_LABELS[value]}</option>`).join("")}</select></div>
      <div class="field"><label>Prioridade</label><select name="priority">${PRIORITIES.map((value) => `<option value="${value}">${LABELS[value]}</option>`).join("")}</select></div>
      <div class="field"><label for="ticket-assignee">Atribuir a</label><select id="ticket-assignee" name="assigneeId" required><option value="">Selecione uma pessoa</option>${assignees.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(LABELS[item.role] || item.role)}</option>`).join("")}</select></div></div>
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
  const mayEdit = canEditTicket(user, ticket);
  const isOwner = ticket.workflowOwnerId === user.id || canAdminister(user);
  const workflowStepLabel = { triagem: "Aguardando atribuição", orcamento: "Contato com Thomas e orçamento", financeiro: "Aprovação do Financeiro", execucao: "Serviço aprovado, aguardando execução", resolvido: "Fluxo concluído" }[ticket.workflowStep] || ticket.workflowStep;
  const teamAssignees = state.users.filter((item) => ["atendente", "financeiro", "admin", "coordenador"].includes(item.role));
  return layout(user, ticket.number, `<button class="btn secondary" data-go="/tickets">Voltar à fila</button>`, `
    <div class="grid-2"><section class="detail"><h2 style="font-family:Fraunces,serif;margin:0 0 8px">${escapeHtml(ticket.title)}</h2><p>${escapeHtml(ticket.description)}</p><h3>Histórico</h3>
      <div class="comments">${renderTimeline(ticket)}</div>${mayEdit ? `<form id="comment-form"><div class="field"><label for="body">Nova atualização</label><textarea id="body" name="body" required placeholder="O que mudou?"></textarea></div><button class="btn" type="submit">Publicar</button></form>` : `<p class="hint">Somente a pessoa responsável pode comentar neste chamado.</p>`}
    </section><aside class="detail"><dl class="meta-list"><div><span>Etapa do fluxo</span><strong>${escapeHtml(workflowStepLabel)}</strong></div><div><span>Status</span>${badgeStatus(ticket.status)}</div><div><span>Prioridade</span>${badgePriority(ticket.priority)}</div><div><span>Categoria</span><span>${escapeHtml(ticket.category)}</span></div>${ticket.location ? `<div><span>Local</span><span>${escapeHtml(ticket.location)}</span></div>` : ""}<div><span>Solicitante</span><span>${escapeHtml(requester?.name || "—")}</span></div><div><span>Responsável atual</span><span>${escapeHtml(assignee?.name || "Fila livre")}</span></div><div><span>Andreza acompanha</span><span>${escapeHtml(userById(ticket.workflowOwnerId)?.name || "Não atribuída")}</span></div><div><span>Financeiro</span><span>${escapeHtml(userById(ticket.financialAssigneeId)?.name || "Não atribuído")}</span></div>${ticket.budgetAmount ? `<div><span>Orçamento</span><span>${Number(ticket.budgetAmount).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span></div>` : ""}${ticket.financeDecision !== "pendente" ? `<div><span>Decisão financeira</span><span>${ticket.financeDecision === "aprovado" ? "Aprovado" : "Rejeitado"}${ticket.financeNote ? ` — ${escapeHtml(ticket.financeNote)}` : ""}</span></div>` : ""}<div><span>Aberto</span><span>${formatDate(ticket.createdAt)}</span></div></dl>
      ${canAdminister(user) ? `<form id="manage-form" style="margin-top:18px"><h3>Responsáveis do fluxo</h3><div class="field"><label>Andreza acompanha o chamado</label><select name="workflowOwnerId"><option value="">Selecione Andreza</option>${teamAssignees.filter((item) => item.role !== "financeiro").map((item) => `<option value="${item.id}" ${ticket.workflowOwnerId === item.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></div><div class="field"><label>Responsável do Financeiro</label><select name="financialAssigneeId"><option value="">Selecione Financeiro</option>${state.users.filter((item) => item.role === "financeiro").map((item) => `<option value="${item.id}" ${ticket.financialAssigneeId === item.id ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></div><div class="field"><label>Responsável atual</label><select name="assigneeId"><option value="">Fila livre</option>${teamAssignees.map((item) => `<option value="${item.id}" ${ticket.assigneeId === item.id ? "selected" : ""}>${escapeHtml(item.name)} · ${LABELS[item.role]}</option>`).join("")}</select></div><div class="field"><label>Prioridade</label><select name="priority">${PRIORITIES.map((value) => `<option value="${value}" ${ticket.priority === value ? "selected" : ""}>${LABELS[value]}</option>`).join("")}</select></div><button class="btn copper full" type="submit">Salvar responsáveis</button></form>` : ""}
      ${ticket.workflowStep === "triagem" && isOwner ? `<button class="btn copper full workflow-action" type="button" data-workflow-start="${ticket.id}">Iniciar contato e pedir orçamento</button>` : ""}
      ${ticket.workflowStep === "orcamento" && isOwner ? `<form id="quote-form" class="workflow-form"><h3>Enviar orçamento ao Financeiro</h3><p class="hint">Registre o valor e anexe o orçamento recebido do Thomas.</p><div class="field"><label>Valor (R$)</label><input name="amount" type="number" min="0.01" step="0.01" required /></div><div class="field"><label>Arquivo do orçamento</label><input name="quote" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/jpeg,image/png,image/webp" required /></div><button class="btn copper full" type="submit">Encaminhar para aprovação</button></form>` : ""}
      ${ticket.workflowStep === "financeiro" && user.role === "financeiro" && ticket.assigneeId === user.id ? `<form id="finance-form" class="workflow-form"><h3>Decisão do Financeiro</h3><div class="field"><label>Observação (obrigatória para rejeitar)</label><textarea name="note" placeholder="Motivo da decisão"></textarea></div><div class="filters"><button class="btn copper" type="button" data-finance-decision="approve">Aprovar</button><button class="btn secondary" type="button" data-finance-decision="reject">Rejeitar</button></div></form>` : ""}
      ${ticket.workflowStep === "execucao" && isOwner ? `<section class="workflow-form"><h3>Após a execução por Thomas</h3><p class="hint">Quando Thomas concluir o serviço, confirme para resolver o chamado.</p><button class="btn copper full" type="button" data-workflow-complete="${ticket.id}">Confirmar serviço e resolver</button></section>` : ""}
      ${ticket.attachments.length ? `<section class="workflow-form"><h3>Orçamentos e arquivos</h3>${ticket.attachments.map((item) => `<button class="attachment-link" type="button" data-attachment-path="${escapeHtml(item.filePath)}">${escapeHtml(item.fileName)} · ${formatDate(item.createdAt)}</button>`).join("")}</section>` : ""}
    </aside></div>`);
}

function renderUsers(user) {
  if (!canAdminister(user)) return layout(user, "Equipe", "", `<div class="empty">Somente a administração e a coordenação podem cadastrar pessoas.</div>`);
  const teamRows = state.users.map((person) => `
    <tr><td>${escapeHtml(person.name)}</td><td>${person.id !== user.id && person.role !== "admin" ? `<select data-user-role="${person.id}" aria-label="Perfil de ${escapeHtml(person.name)}"><option value="colaborador" ${person.role === "colaborador" ? "selected" : ""}>Colaborador</option><option value="atendente" ${person.role === "atendente" ? "selected" : ""}>Atendente</option><option value="financeiro" ${person.role === "financeiro" ? "selected" : ""}>Financeiro</option><option value="coordenador" ${person.role === "coordenador" ? "selected" : ""}>Coordenador</option></select>` : LABELS[person.role] || escapeHtml(person.role)}</td><td class="user-actions">${person.id !== user.id && person.role !== "admin" ? `<button class="btn secondary small-btn" type="button" data-save-user-role="${person.id}">Salvar perfil</button>${person.role !== "coordenador" ? `<button class="delete-user-button" type="button" data-delete-user="${escapeHtml(person.id)}" aria-label="Excluir conta de ${escapeHtml(person.name)}" title="Excluir conta"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3" /></svg></button>` : ""}` : ""}</td></tr>
  `).join("");
  return layout(user, "Equipe", "", `
    <div class="grid-2">
      <section class="panel">
        <h2>Usuários cadastrados</h2>
        ${teamRows ? `<table><thead><tr><th>Nome</th><th>Perfil</th><th><span class="sr-only">Ações</span></th></tr></thead><tbody>${teamRows}</tbody></table>` : `<div class="empty">Ainda não há pessoas cadastradas.</div>`}
      </section>
      <form class="card" id="user-form">
        <h2>Cadastrar pessoa</h2>
        <p class="hint">A pessoa poderá acessar os chamados conforme o perfil selecionado.</p>
        <div class="field"><label for="user-name">Nome</label><input id="user-name" name="name" required maxlength="100" autocomplete="name" /></div>
        <div class="field"><label for="user-email">E-mail de trabalho</label><input id="user-email" name="email" type="email" required maxlength="254" autocomplete="email" /></div>
        <div class="field"><label for="user-password">Senha inicial</label><input id="user-password" name="password" type="password" required minlength="8" maxlength="72" autocomplete="new-password" /><small class="hint">Use pelo menos 8 caracteres e entregue a senha à pessoa por um canal seguro.</small></div>
        <div class="field"><label for="user-role">Perfil</label><select id="user-role" name="role"><option value="colaborador">Colaborador</option><option value="atendente">Atendente</option><option value="financeiro">Financeiro</option><option value="coordenador">Coordenador</option></select></div>
        <button class="btn copper full" type="submit">Criar conta</button>
      </form>
    </div>
  `);
}

function bind() {
  document.querySelectorAll("[data-notification-id]").forEach((element) => element.addEventListener("click", async () => {
    const ticketId = element.dataset.notificationTicket;
    await markNotificationRead(element.dataset.notificationId);
    if (ticketId) go(`/tickets/${ticketId}`);
  }));
  document.querySelectorAll("[data-save-user-role]").forEach((element) => element.addEventListener("click", () => {
    const select = document.querySelector(`[data-user-role="${element.dataset.saveUserRole}"]`);
    if (select) updateEmployeeRole(element.dataset.saveUserRole, select.value);
  }));
  document.querySelectorAll("[data-delete-user]").forEach((element) => element.addEventListener("click", () => deleteEmployee(element.dataset.deleteUser)));
  document.querySelectorAll("[data-go]").forEach((element) => element.addEventListener("click", () => go(element.getAttribute("data-go"))));
  document.querySelectorAll("[data-slot-room]").forEach((element) => element.addEventListener("click", () => {
    selectedSlot = { roomId: element.dataset.slotRoom, date: reservationDate,
      time: element.dataset.slotTime, duration: reservationDuration };
    go("/reservations/new");
  }));
  document.getElementById("booking-date")?.addEventListener("change", (event) => {
    reservationDate = event.target.value;
    if (reservationDate) loadAvailability(reservationDate).catch(showError);
  });
  document.getElementById("booking-duration")?.addEventListener("change", (event) => {
    reservationDuration = Number(event.target.value);
    render();
  });
  document.getElementById("refresh-bookings")?.addEventListener("click", () => {
    if (reservationDate < dateInBookingZone()) reservationDate = dateInBookingZone();
    loadWorkspace().catch(showError);
  });
  const bookingForm = document.getElementById("booking-form");
  bookingForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(bookingForm);
    createBooking({ ...selectedSlot, clientName: String(data.get("clientName")), subject: String(data.get("subject")) });
  });
  document.querySelectorAll("[data-edit-booking]").forEach((element) => element.addEventListener("click", () => go(`/booking/${element.dataset.editBooking}`)));
  const bookingEditForm = document.getElementById("booking-edit-form");
  bookingEditForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(bookingEditForm);
    updateBooking(route.id, Object.fromEntries(data.entries()));
  });
  document.querySelectorAll("[data-cancel-booking]").forEach((element) => element.addEventListener("click", () => {
    if (window.confirm("Cancelar esta reserva?")) cancelBooking(element.dataset.cancelBooking);
  }));
  document.querySelectorAll("[data-workflow-start]").forEach((element) => element.addEventListener("click", () => startWorkflowTicket(element.dataset.workflowStart)));
  document.querySelectorAll("[data-workflow-complete]").forEach((element) => element.addEventListener("click", () => completeWorkflowTicket(element.dataset.workflowComplete)));
  document.querySelectorAll("[data-attachment-path]").forEach((element) => element.addEventListener("click", () => openAttachment(element.dataset.attachmentPath)));
  document.querySelectorAll("[data-finance-decision]").forEach((element) => element.addEventListener("click", () => {
    const note = document.querySelector('#finance-form [name="note"]')?.value || "";
    decideQuote(route.id, element.dataset.financeDecision === "approve", note);
  }));
  document.querySelectorAll("[data-room-toggle]").forEach((element) => element.addEventListener("click", () => {
    setRoomActive(element.dataset.roomToggle, element.dataset.roomActive === "true");
  }));
  document.getElementById("booking-lawyer")?.addEventListener("change", (event) => {
    adminBookingLawyerId = event.target.value;
    render();
  });
  document.getElementById("booking-search")?.addEventListener("input", (event) => {
    adminBookingQuery = event.target.value;
    const cursor = event.target.selectionStart;
    render();
    const refreshed = document.getElementById("booking-search");
    refreshed?.focus();
    refreshed?.setSelectionRange(cursor, cursor);
  });
  const roomForm = document.getElementById("room-form");
  roomForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(roomForm);
    addRoom({ name: String(data.get("name")), capacity: data.get("capacity") });
  });
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
    createTicket({ title: String(data.get("title")), description: String(data.get("description")), category: String(data.get("category")), priority: String(data.get("priority")), assigneeId: String(data.get("assigneeId")), location: String(data.get("location")) });
  });
  const commentForm = document.getElementById("comment-form");
  commentForm?.addEventListener("submit", (event) => { event.preventDefault(); addComment(route.id, String(new FormData(commentForm).get("body"))); });
  const manageForm = document.getElementById("manage-form");
  manageForm?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(manageForm);
    const patch = { priority: String(data.get("priority")), workflowOwnerId: String(data.get("workflowOwnerId")), financialAssigneeId: String(data.get("financialAssigneeId")) };
    if (data.has("assigneeId")) patch.assigneeId = String(data.get("assigneeId")) || null;
    updateTicket(route.id, patch);
  });
  const quoteForm = document.getElementById("quote-form");
  quoteForm?.addEventListener("submit", (event) => {
    event.preventDefault(); const data = new FormData(quoteForm);
    submitQuoteForApproval(route.id, String(data.get("amount")), data.get("quote"));
  });
  ["q", "status"].forEach((id) => {
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
  if (route.name === "booking") root.innerHTML = renderBookingEditor(user);
  else if (route.name === "reservations" && route.id === "new") root.innerHTML = renderBookingForm(user);
  else if (route.name === "reservations") root.innerHTML = renderReservations(user);
  else if (route.name === "tickets" && route.id) root.innerHTML = renderTicket(user);
  else if (route.name === "tickets") root.innerHTML = renderTickets(user);
  else if (route.name === "new") root.innerHTML = renderNew(user);
  else if (route.name === "users") root.innerHTML = renderUsers(user);
  else { go("/tickets"); return; }
  bind();
}

window.addEventListener("hashchange", () => {
  route = parseHash();
  flashError = "";
  if (!keepSuccessOnNavigation) flashSuccess = "";
  keepSuccessOnNavigation = false;
  render();
});

async function boot() {
  if (!window.supabase || !window.HEKP_SUPABASE?.url || !window.HEKP_SUPABASE?.publishableKey) { loading = false; render(); return; }
  try {
    db = window.supabase.createClient(window.HEKP_SUPABASE.url, window.HEKP_SUPABASE.publishableKey);
    if (!notificationPoll) notificationPoll = window.setInterval(refreshNotifications, 30000);
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    if (data.session) await loadWorkspace();
    else { loading = false; render(); }
    db.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        state = { user: null, users: [], tickets: [], rooms: [], bookings: [], busy: [], reservationsReady: false };
        resetReservationSession();
        loading = false;
        render();
      }
    });
  } catch (error) { showError(error); }
}

render();
boot();
