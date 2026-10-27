# Help Desk

Aplicação web para registrar e acompanhar solicitações internas de uma organização. O projeto centraliza informações em um só lugar e oferece uma interface simples para que as pessoas acompanhem o andamento das solicitações.

## Arquitetura e metodologia

O sistema usa uma arquitetura de aplicação de página única (SPA): a interface é carregada no navegador e atualizada sem recarregar páginas completas. O frontend é estático e conversa com o Supabase, que fornece autenticação, banco de dados e armazenamento.

A organização segue separação de responsabilidades: a interface apresenta e coleta informações; o Supabase gerencia identidade e persistência; e as regras de acesso e integridade são aplicadas também no banco. Isso evita depender apenas de verificações visuais no navegador para proteger os dados.

A abordagem de desenvolvimento é incremental: funcionalidades são construídas em partes pequenas, mantendo a aplicação utilizável enquanto o sistema evolui. A escolha por uma SPA sem framework reduz dependências e etapas de build, o que mantém a estrutura direta e fácil de hospedar.

## Linguagens e tecnologias

| Tecnologia | Uso | Por que foi escolhida |
| --- | --- | --- |
| **HTML** | Estrutura das páginas e dos elementos da interface. | É o padrão da web e oferece uma base sem dependências para o conteúdo. |
| **CSS** | Layout, cores, tipografia e adaptação a diferentes telas. | Mantém a apresentação separada da lógica e permite ajustar a interface com leveza. |
| **JavaScript** | Interações, navegação, validações de interface e comunicação com o Supabase. | Executa diretamente no navegador e atende às necessidades do frontend sem exigir uma etapa de compilação. |
| **SQL** | Estrutura e consultas do banco, além de regras de integridade e acesso. | É a linguagem nativa do PostgreSQL usado pelo Supabase, permitindo expressar regras junto aos dados. |
| **TypeScript** | Funções executadas no servidor. | Acrescenta verificação de tipos ao JavaScript e ajuda a reduzir erros em operações que exigem acesso controlado ao servidor. |

### Serviços

- **Supabase** fornece autenticação, PostgreSQL e armazenamento de arquivos.
- **Supabase Edge Functions** executa operações que devem permanecer no servidor.
- **Cloudflare Workers** hospeda a aplicação web.

