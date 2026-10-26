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

8. Entre no app com a conta administradora. No menu **Equipe**, crie colaboradores, atendentes, pessoas do Financeiro e coordenadores. As novas contas ficam associadas automaticamente ao escritório do administrador. O formulário não permite criar outra conta de administração.

9. Para permitir que administração e coordenação excluam contas pela página **Equipe**, execute [`supabase/account-deletion.sql`](supabase/account-deletion.sql) no SQL Editor. Depois, publique a Edge Function `delete-user`: crie uma função com esse nome em **Edge Functions → Deploy a new function → Via Editor**, copie `supabase/functions/delete-user/index.ts`, mantenha a verificação JWT ativa e publique. A lixeira não aparece para a própria conta nem para contas de administração ou coordenação. Chamados, comentários e reservas são mantidos no histórico sem vínculo com a conta excluída.

## Reservas de salas

Depois de executar o esquema inicial, abra o **SQL Editor** do mesmo projeto Supabase e execute [`supabase/room-reservations.sql`](supabase/room-reservations.sql). O arquivo cria as salas, as reservas, as permissões e a função que consulta somente os horários ocupados. Ele pode ser executado novamente sem apagar reservas existentes. Se o aplicativo for publicado antes dessa migração, os chamados continuam disponíveis e a agenda mostra um aviso de configuração pendente.

Entre com uma conta de **administração** e abra **Reservas de salas** para cadastrar as salas de cada escritório. Depois disso, pessoas com perfil **colaborador** já podem consultar horários e reservar. Não é necessário criar um perfil de advogado: o colaborador é o advogado neste fluxo.

- A agenda usa o horário de Brasília (`America/Sao_Paulo`) e oferece reuniões de 30, 60, 90 ou 120 minutos entre 08:00 e 18:00.
- Todos os usuários autenticados veem as reuniões agendadas, incluindo cliente e assunto. Cada pessoa pode editar ou cancelar as próprias reuniões; administração e coordenação podem gerenciar qualquer reunião e consultar o resumo por advogado e cliente.
- A reserva é confirmada ao salvar. O banco bloqueia reservas sobrepostas para a mesma sala, mesmo que duas pessoas tentem salvar ao mesmo tempo. Uma reserva cancelada libera o horário.
- A administração pode ativar ou desativar salas. Desativar impede novas reservas sem apagar o histórico.
- Todos os usuários autenticados podem consultar as reuniões, incluindo cliente e assunto. Cada pessoa pode editar ou cancelar as próprias reuniões; administração e coordenação podem gerenciar todas.

## Perfis e permissões

Para aplicar os novos perfis em um projeto Supabase já existente, execute [`supabase/user-permissions.sql`](supabase/user-permissions.sql) depois das migrações de reservas de salas. Publique novamente as Edge Functions `create-user` e `delete-user` e publique `update-user` para permitir alterar perfis na página **Equipe**. Crie a função `update-user` em **Edge Functions → Deploy a new function → Via Editor**, copie `supabase/functions/update-user/index.ts`, mantenha a verificação JWT ativa e publique.

- **Colaborador e atendente:** podem consultar somente os chamados que abriram ou que foram atribuídos a eles; só podem comentar ou alterar chamados atribuídos a eles. Podem consultar todas as reuniões e editar ou cancelar apenas as próprias.
- **Coordenador:** tem as permissões de administração: pode gerenciar todos os chamados e reuniões, atribuir chamados, administrar salas, escritórios e contas de equipe.
- **Administração:** mantém as permissões completas do sistema.

As regras também são aplicadas no Supabase, então esconder um botão no navegador não é a única proteção.

## Fluxo de orçamento e aprovação

Depois das migrações acima, execute [`supabase/ticket-workflow.sql`](supabase/ticket-workflow.sql) no SQL Editor. Ela adiciona as etapas do fluxo, o perfil Financeiro, anexos privados, notificações internas, validações e políticas RLS. Para cadastrar pessoas do Financeiro pela tela **Equipe**, publique novamente as Edge Functions `create-user` e `update-user` usando os arquivos atualizados em `supabase/functions/`.

Em seguida, execute [`supabase/ticket-assignment.sql`](supabase/ticket-assignment.sql). Na abertura do chamado, quem solicita escolhe uma pessoa responsável; o escritório fica oculto e é preenchido automaticamente pelo perfil de quem abriu o chamado.

1. Em **Equipe**, crie o usuário da Andreza com perfil **Atendente** e o usuário do Financeiro com perfil **Financeiro**. Use contas separadas da sua conta de administração.
2. No chamado, administração ou coordenação escolhe Andreza como responsável contínua, escolhe a pessoa do Financeiro e inicia o contato. Andreza continua acompanhando mesmo quando o Financeiro assume a etapa.
3. Andreza contata Thomas fora do app, anexa o orçamento em PDF ou imagem e informa o valor. O chamado passa ao Financeiro.
4. O Financeiro aprova ou rejeita e registra a observação. A decisão fica no histórico; o chamado volta para Andreza.
5. Após combinar e acompanhar o serviço com Thomas, Andreza confirma a conclusão e resolve o chamado.

As notificações aparecem dentro do app e são atualizadas em até 30 segundos enquanto a sessão estiver aberta. Este fluxo não envia e-mail nem integra o WhatsApp. Os arquivos ficam em bucket privado do Supabase Storage e os links de visualização expiram após um minuto.

## Abrir e publicar

Para uma verificação inicial, sirva esta pasta por um servidor web estático e abra o endereço local. Para uso da equipe, publique os arquivos em uma hospedagem estática com HTTPS (por exemplo, Vercel ou Netlify). `index.html`, `app.js`, `styles.css` e `config.js` precisam estar no mesmo diretório.

Para permitir redefinição de senha, em **Authentication → URL Configuration → Redirect URLs**, adicione o endereço completo do app seguido de `?auth-recovery=1` (por exemplo, `https://seu-dominio.com/?auth-recovery=1`). O endereço precisa corresponder ao endereço em que o app está aberto; em desenvolvimento local, autorize também a URL local usada pelo servidor web. O link enviado antes de publicar essa tela deve ser solicitado novamente depois da configuração.

O navegador carrega `supabase-js` pela CDN jsDelivr, então a hospedagem e os navegadores precisam de acesso à internet. A URL do projeto e a chave **publishable** são usadas pelo cliente web; a segurança dos dados depende das políticas RLS incluídas no SQL. Nunca use chaves `secret` ou `service_role` no navegador nem em `config.js`.

## Papéis e dados

- **Colaborador:** abre chamados para o próprio escritório e consulta somente os que abriu ou que foram atribuídos a ele. Só pode comentar ou atualizar os que estiverem atribuídos a ele.
- **Atendente:** consulta chamados atribuídos a ele ou que abriu. A pessoa atribuída como responsável contínua também acompanha e comenta durante as etapas de aprovação.
- **Financeiro:** consulta e decide orçamentos atribuídos a ele. Não pode trocar os responsáveis nem alterar o valor recebido.
- **Coordenador e administração:** podem consultar e gerenciar todos os chamados, atribuí-los e administrar escritórios, salas e contas de equipe.
- Comentários e alterações de status, prioridade e responsável aparecem no histórico e seguem a mesma visibilidade do chamado.
- Senhas e sessões são gerenciadas pelo Supabase Auth. Não há contas ou chamados de demonstração no app.

## Limites deste MVP

O MVP envia notificações somente dentro do app, não envia e-mail, não integra o WhatsApp e não define SLA. A conta inicial de administração ainda precisa ser criada no Supabase antes da primeira entrada. Faça um piloto com dados não sensíveis até revisar o acesso, backups e políticas operacionais do projeto.
