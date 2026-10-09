# Hekp Gesk — MVP de help desk

Aplicação web para abrir e acompanhar chamados dos escritórios. A autenticação e os dados compartilhados usam Supabase (Auth + Postgres), com regras de acesso aplicadas no banco.

## Configurar o Supabase

1. Crie um projeto no Supabase.
2. No SQL Editor do projeto, execute o arquivo `supabase-schema.sql`.
3. Em **Project Settings → API**, copie a URL do projeto e a chave **publishable**. Abra `config.js` e preencha `url` e `publishableKey`.
4. Em **Authentication → Users**, crie o primeiro usuário administrador com e-mail e senha. Desative o cadastro público de usuários nas configurações de Auth.
5. No SQL Editor, localize o UUID do usuário em **Authentication → Users** e consulte o escritório que será associado:

   ```sql
   select id, name from public.offices order by name;
   ```

6. Crie o perfil do administrador, substituindo os dois UUIDs pelos valores do seu projeto:

   ```sql
   insert into public.profiles (id, name, role, office_id)
   values ('UUID_DO_USUARIO_AUTH', 'Nome do administrador', 'admin', 'UUID_DO_ESCRITORIO');
   ```

7. Para cadastrar usuários pela aplicação, publique a função `create-user` uma vez:

   - No projeto Supabase, abra **Edge Functions → Deploy a new function → Via Editor**.
   - Nomeie a função `create-user`.
   - Copie o conteúdo de `supabase/functions/create-user/index.ts` para o editor.
   - Mantenha a verificação JWT ativa e clique em **Deploy function**.

   O Supabase disponibiliza as chaves secretas à Edge Function no servidor. Não copie nenhuma chave secreta para o navegador. Consulte a [documentação de publicação pelo Dashboard](https://supabase.com/docs/guides/functions/quickstart-dashboard) e [segurança de Edge Functions](https://supabase.com/docs/guides/functions/auth).

8. Entre no app com a conta administradora. No menu **Equipe**, crie colaboradores e atendentes. As novas contas ficam associadas automaticamente ao escritório do administrador. O formulário não permite criar outro administrador.

## Reservas de salas

Depois de executar o esquema inicial, abra o **SQL Editor** do mesmo projeto Supabase e execute [`supabase/room-reservations.sql`](supabase/room-reservations.sql). O arquivo cria as salas, as reservas, as permissões e a função que consulta somente os horários ocupados. Ele pode ser executado novamente sem apagar reservas existentes. Se o aplicativo for publicado antes dessa migração, os chamados continuam disponíveis e a agenda mostra um aviso de configuração pendente.

Entre com uma conta de **administração** e abra **Reservas de salas** para cadastrar as salas de cada escritório. Depois disso, pessoas com perfil **colaborador** já podem consultar horários e reservar. Não é necessário criar um perfil de advogado: o colaborador é o advogado neste fluxo.

- A agenda usa o horário de Brasília (`America/Sao_Paulo`) e oferece reuniões de 30, 60, 90 ou 120 minutos entre 08:00 e 18:00.
- Colaboradores veem os horários ocupados de todos, mas os detalhes somente das próprias reservas. A administração vê todas as reservas, os clientes e o total de reuniões futuras por advogado e cliente.
- A reserva é confirmada ao salvar. O banco bloqueia reservas sobrepostas para a mesma sala, mesmo que duas pessoas tentem salvar ao mesmo tempo. Uma reserva cancelada libera o horário.
- A administração pode ativar ou desativar salas. Desativar impede novas reservas sem apagar o histórico.

## Abrir e publicar

Para uma verificação inicial, sirva esta pasta por um servidor web estático e abra o endereço local. Para uso da equipe, publique os arquivos em uma hospedagem estática com HTTPS (por exemplo, Vercel ou Netlify). `index.html`, `app.js`, `styles.css` e `config.js` precisam estar no mesmo diretório.

Para permitir redefinição de senha, em **Authentication → URL Configuration → Redirect URLs**, adicione o endereço completo do app seguido de `?auth-recovery=1` (por exemplo, `https://seu-dominio.com/?auth-recovery=1`). O endereço precisa corresponder ao endereço em que o app está aberto; em desenvolvimento local, autorize também a URL local usada pelo servidor web. O link enviado antes de publicar essa tela deve ser solicitado novamente depois da configuração.

O navegador carrega `supabase-js` pela CDN jsDelivr, então a hospedagem e os navegadores precisam de acesso à internet. A URL do projeto e a chave **publishable** são usadas pelo cliente web; a segurança dos dados depende das políticas RLS incluídas no SQL. Nunca use chaves `secret` ou `service_role` no navegador nem em `config.js`.

## Papéis e dados

- **Colaborador:** abre chamados para o próprio escritório e vê os chamados que abriu.
- **Atendente:** vê a fila completa, comenta, altera status e prioridade e atribui responsáveis.
- **Administração:** tem as permissões de atendente, pode cadastrar escritórios e criar contas de colaborador e atendente pela página **Equipe**.
- Comentários e alterações de status, prioridade e responsável aparecem no histórico do chamado.
- Senhas e sessões são gerenciadas pelo Supabase Auth. Não há contas ou chamados de demonstração no app.

## Limites deste MVP

O MVP não envia notificações por e-mail, não tem anexos, não permite alterar ou desativar contas pela página Equipe e não define SLA. A conta inicial de administração ainda precisa ser criada no Supabase antes da primeira entrada. Faça um piloto com dados não sensíveis até revisar o acesso, backups e políticas operacionais do projeto.
