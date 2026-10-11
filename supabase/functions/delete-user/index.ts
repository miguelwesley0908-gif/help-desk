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

const handleDeleteUser = withSupabase({ auth: "user" }, async (request, context) => {
  if (request.method !== "POST") return respond({ error: "Método não permitido." }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return respond({ error: "Envie o ID da conta em formato JSON." }, 400);
  }

  const adminId = context.userClaims?.id;
  const userId = typeof payload.userId === "string" ? payload.userId : "";
  if (!adminId) return respond({ error: "Não foi possível identificar sua conta. Entre novamente." }, 401);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return respond({ error: "Selecione uma conta válida para excluir." }, 400);
  }
  if (userId === adminId) return respond({ error: "Você não pode excluir a própria conta." }, 400);

  const { data: adminProfile, error: adminLookupError } = await context.supabase
    .from("profiles")
    .select("id,role")
    .eq("id", adminId)
    .single();
  if (adminLookupError || !adminProfile) return respond({ error: "Não foi possível conferir seu perfil." }, 403);
  if (adminProfile.role !== "admin") return respond({ error: "Somente a administração pode excluir contas." }, 403);

  const { data: targetProfile, error: targetLookupError } = await context.supabase
    .from("profiles")
    .select("id,name,role")
    .eq("id", userId)
    .maybeSingle();
  if (targetLookupError) return respond({ error: "Não foi possível localizar essa conta." }, 500);
  if (!targetProfile) return respond({ error: "Essa conta não existe ou já foi excluída." }, 404);
  if (targetProfile.role === "admin") return respond({ error: "Contas de administração não podem ser excluídas por esta tela." }, 400);

  const { error: deleteError } = await context.supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteError) return respond({ error: deleteError.message || "Não foi possível excluir a conta." }, 500);

  return respond({ deleted: true, userId }, 200);
});

export default {
  fetch(request: Request) {
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    return handleDeleteUser(request);
  },
};
