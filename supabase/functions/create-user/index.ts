import { withSupabase } from "npm:@supabase/server@1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

const handleCreateUser = withSupabase({ auth: "user" }, async (request, context) => {
  if (request.method !== "POST") return respond({ error: "Método não permitido." }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return respond({ error: "Envie os dados do novo usuário em formato JSON." }, 400);
  }

  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  const role = ["colaborador", "atendente", "coordenador"].includes(String(payload.role)) ? String(payload.role) : "";
  const adminId = context.userClaims?.id;

  if (!adminId) return respond({ error: "Não foi possível identificar sua conta. Entre novamente." }, 401);
  if (!name || name.length > 100) return respond({ error: "Informe um nome com até 100 caracteres." }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return respond({ error: "Informe um e-mail válido." }, 400);
  if (password.length < 8 || password.length > 72) return respond({ error: "A senha inicial deve ter entre 8 e 72 caracteres." }, 400);
  if (!role) return respond({ error: "Escolha Colaborador, Atendente ou Coordenador." }, 400);

  const { data: adminProfile, error: profileLookupError } = await context.supabase
    .from("profiles")
    .select("id,role,office_id")
    .eq("id", adminId)
    .single();

  if (profileLookupError || !adminProfile) return respond({ error: "Não foi possível conferir seu perfil." }, 403);
  if (!['admin', 'coordenador'].includes(adminProfile.role)) return respond({ error: "Somente a administração ou coordenação pode cadastrar usuários." }, 403);

  const { data: created, error: createError } = await context.supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });

  if (createError || !created.user) {
    const duplicate = createError?.message.toLowerCase().includes("already") || createError?.message.toLowerCase().includes("registered");
    return respond({ error: duplicate ? "Já existe uma conta com esse e-mail." : createError?.message || "Não foi possível criar a conta." }, duplicate ? 409 : 400);
  }

  const { error: insertProfileError } = await context.supabaseAdmin.from("profiles").insert({
    id: created.user.id,
    name,
    role,
    office_id: adminProfile.office_id,
  });

  if (insertProfileError) {
    await context.supabaseAdmin.auth.admin.deleteUser(created.user.id);
    return respond({ error: "A conta foi criada, mas o perfil não foi salvo. A operação foi cancelada; tente novamente." }, 500);
  }

  return respond({ user: { id: created.user.id, name, email, role } }, 201);
});

export default {
  fetch(request: Request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    return handleCreateUser(request);
  },
};
