# Gestão — API

NestJS 11 · Prisma 6 · PostgreSQL 16. Multi-tenant (uma API, várias empresas), sessão por cookie `httpOnly`, RBAC por papel.

## Rodando

```bash
cd server
cp .env.example .env          # já existe um .env de desenvolvimento
npm install
npm run db:up                 # PostgreSQL em 127.0.0.1:5440 (docker compose, projeto "gestao")
npx prisma generate           # o npm bloqueia scripts de pós-instalação; gere o client uma vez
npm run prisma:migrate        # aplica as migrações
npm run db:seed               # empresa demo: bruno@empresaabc.com.br / senha1234 (nunca em produção)
npm run start:dev             # http://localhost:4000
```

Frontend: `web/.env.local` com `NEXT_PUBLIC_API_URL=http://localhost:4000` (é também o padrão) e `npm run dev`. **O frontend não tem mais dados mock**: tudo vem daqui e, portanto, do banco. Os dados de demonstração vivem no `prisma/seed.ts`.

Testes (banco separado `gestao_test`, criado pelo compose): `npm test`.

> **Docker:** o `docker-compose.yml` define `name: gestao` de propósito. Sem isso o Compose usa o nome da pasta (`server`) e pode recriar containers de *outros* projetos que também estejam numa pasta `server`.

## Endpoints (iguais ao contrato que o frontend já usa)

| Área | Rotas | Permissão |
|---|---|---|
| Auth | `POST /auth/register` `login` `logout` `forgot-password` `reset-password`, `GET /auth/me` | públicas (exceto `me`) |
| Empresa | `GET/PUT /company`, `POST /company` (onboarding), `GET /company/audit` | `settings:*` |
| Usuários | `GET /users`, `POST /users/invite`, `PATCH /users/:id` | `settings:*` |
| Produtos | `GET /products`, `/products/search?q=`, `/products/:id`, `POST`, `PUT /:id`, `DELETE /:id` | `products:*` |
| Clientes | `GET /customers`, `/search`, `/:id`, `/:id/purchases`, `POST` | `customers:*` |
| Vendas | `GET /sales`, `/sales/summary`, `/sales/:id`, `POST /sales`, `POST /sales/:id/complete`, `POST /sales/:id/cancel` | `sales:*` |
| PDV / caixa | `GET /pos/register`, `POST /pos/register/open` `close` `withdrawal` `deposit`, `POST /pos/sales`, `GET /pos/sales` | `pos:*` |
| Financeiro | `GET /finance/overview` `accounts` `categories` `transactions`; `GET/POST /finance/payables` e `/finance/receivables`; `POST …/:id/settle` | `finance:*` |
| Carteira | `GET /wallet/summary` `statement` (saldo corrente por função de janela) | `wallet:view` |
| Estoque | `GET /inventory/summary` `movements`, `POST /inventory/movements` (entrada, saída, ajuste) | `inventory:*` |
| Painel | `GET /dashboard?range=` `dashboard/checklist`, `GET /reports/:group?range=`, `GET /search?q=` | `dashboard:view` / `reports:view` |
| Notificações | `GET /notifications`, `POST /notifications/:id/read` `read-all` (leitura por usuário) | `dashboard:view` |
| Automações | `GET/POST /automations`, `GET /:id`, `POST /:id/toggle` | `automations:*` |
| Assinatura | `GET /subscription`, `POST /subscription/checkout` `cancel` | `settings:*` |
| Fiscal | `GET /fiscal/notes` `summary` `pending-sales` `settings`, `POST /fiscal/notes` (+`/:id/retry` `cancel`), `PUT /fiscal/settings` | `fiscal:*` |
| PIX | `GET /pix/settings` `summary` `charges`, `PUT /pix/settings`, `POST /pix/charges` (+`/:id/cancel` `simulate-payment`) | `finance:*` |
| Conciliação | `GET /bank/connections` `summary` `lines`, `POST /bank/connections/:id/toggle`, `/bank/lines/:id/reconcile` `create-entry` `ignore`, `POST /bank/import` (OFX/CSV no corpo) | `finance:*` |
| Marketplaces | `GET /marketplaces` `summary` `orders` `listings`, `POST /marketplaces/:id/connect` `disconnect` `sync`, `PATCH /:id`, `POST /orders/:id/invoice`, `POST /listings/:productId/toggle` | `marketplaces:*` |
| Upload | `POST /uploads/image` (multipart, campo `file`) → `{ url }` | `products:edit` |
| Saúde | `GET /health` | pública |

Listagens aceitam `page`, `pageSize`, `search`, `status` e devolvem `{ data, total, page, pageSize }`. Erros: `{ statusCode, message, errors? }` com mensagem em português.

Toda rota autenticada usa o cookie de sessão e o header `X-Organization-Id` (empresa ativa; a API confere que o usuário é membro).

## Decisões de segurança

- **Sessão opaca no servidor**: cookie `httpOnly` + `SameSite=Lax` (`Secure` em produção); no banco fica só o hash SHA-256 do token. Revogável (logout, desativar usuário, redefinir senha derrubam as sessões). Expiração deslizante de 7 dias, teto de 30.
- **Senhas**: bcrypt (custo 12). Login com resposta idêntica para e-mail inexistente e senha errada (e tempo equalizado); bloqueio de 15 min após 5 erros; rate limit por rota.
- **Multi-tenant**: `SessionGuard` valida a empresa do header contra os vínculos do usuário; todo acesso a dados filtra por `organizationId`. Testes e2e cobrem o isolamento.
- **Permissões** (`common/permissions.ts`) espelham `web/src/lib/permissions.ts`; a API é quem barra de verdade.
- **CSRF**: cookie `SameSite=Lax` + rejeição de `POST/PUT/PATCH/DELETE` com `Origin` fora de `WEB_ORIGINS`.
- **Vendas**: transação única; baixa de estoque atômica (`stock >= qty`), numeração sequencial por empresa, cancelamento idempotente que devolve estoque. Dinheiro em `Decimal(14,2)` e cálculos em centavos.
- Entrada validada com `class-validator` (`whitelist` + `forbidNonWhitelisted`); erros 5xx não vazam detalhes; helmet ativo; `X-Powered-By` desligado.
- **Produção**: `NODE_ENV=production` exige `COOKIE_SECURE=true` e `WEB_ORIGINS` em https; atrás de proxy use `TRUST_PROXY=true`; se front e API estiverem em subdomínios, `COOKIE_DOMAIN=.seudominio.com.br`.

## PDV e caixa

Cada operador tem o seu turno de caixa (`CashSession`): abre com o fundo de troco e fecha com a contagem, e a diferença fica registrada. **Os totais (dinheiro, PIX, cartão) são calculados das vendas e movimentações**, nunca gravados em duplicidade, então não saem do compasso ao cancelar uma venda. Índices únicos parciais no banco garantem no máximo um caixa aberto por nome e por operador, mesmo com cliques simultâneos. A sangria trava a linha do turno e nunca passa do dinheiro que existe no caixa. A venda do PDV recalcula tudo no servidor (preço vem do cadastro), recusa se o total mostrado ao operador divergir, exige `pos:discount` para desconto e usa a mesma rotina transacional das vendas (baixa de estoque atômica, numeração da empresa).

## Imagens enviadas

`POST /uploads/image` aceita PNG, JPG e WebP até 2 MB. O tipo é conferido pelos primeiros bytes do arquivo (não pelo nome nem pelo tipo informado), o nome gravado é aleatório e os arquivos ficam em `UPLOAD_DIR` (padrão `server/uploads`), servidos em `/uploads/<empresa>/<arquivo>` sem listagem de pasta e com `nosniff`. O link é público, mas não adivinhável. **Em produção use armazenamento de objetos (S3 ou similar)**: o disco local é apagado a cada novo deploy em muitas hospedagens.

## Mensagens de erro

Erros de validação saem em português, com o nome do campo como aparece no formulário e uma mensagem por campo ("O preço de venda deve ser um número."). Ver `src/common/validation.ts`.

## Convites e e-mail

Convite e "esqueci a senha" geram um token de uso único (guardado como hash). Sem `SMTP_*` configurado, o e-mail (com o link) aparece apenas no log da API — útil em desenvolvimento. Aceitar convite = definir a senha pela tela `/reset-password` (o token de convite também ativa o vínculo).

## Financeiro, carteira e o que a venda dispara

Toda venda concluída (PDV, manual ao ser concluída, pedido de marketplace importado) grava, **na mesma transação**, a entrada no financeiro (`Transaction`): dinheiro vai para o caixa, o resto para a conta bancária/digital. Cancelar lança o estorno (o histórico não é apagado). Baixar uma conta a pagar/receber também gera a movimentação. O saldo de cada conta é *saldo inicial + movimentações confirmadas*; "vencido" não é gravado, sai de pendente + vencimento passado. Depois do commit, a venda avisa a empresa (`Notification`), dispara as automações do gatilho e alerta estoque baixo. Dashboard, relatórios, carteira e busca são **calculados dessas mesmas tabelas**: não há número duplicado para sair de compasso.

## Automações

`Automation` guarda gatilho → condição → ação. `AutomationsService.fire()` é chamado pelos módulos (venda, venda cancelada, estoque baixo, conta recebida, novo cliente, novo produto; "conta vencida" por uma varredura horária). Ações que dependem de integração ainda não configurada (webhook, WhatsApp) marcam a regra com `erro` e avisam a empresa, em vez de fingir que rodaram.

## Integrações externas: sandbox × live

Emissor fiscal, PSP do PIX, Open Finance, OAuth dos marketplaces e gateway de pagamento precisam de contrato com o provedor. Até lá:

- `INTEGRATIONS_MODE=sandbox` (padrão fora de produção): as integrações são **simuladas dentro da API e gravam no banco** (nota autorizada após alguns segundos, "simular pagamento" do PIX, conexão de banco/marketplace por clique). Não inventam dados: sincronizar um marketplace só registra o horário, nenhum pedido falso é criado.
- `INTEGRATIONS_MODE=live` (padrão em produção): sem provedor configurado, essas operações respondem **503** com o que falta ("O emissor de notas fiscais ainda não está configurado…"). Ao contratar um provedor, ele entra no lugar do trecho `requireSandbox` correspondente (`fiscal`, `pix`, `bank`, `marketplaces`, `subscription`).
- O token CSC da NFC-e é guardado **criptografado** (AES-256-GCM, `SECRETS_KEY`) e nunca volta em claro pela API. O certificado A1 e a senha ficam com o emissor fiscal: a API guarda só nome e validade.
- Extratos bancários: `POST /bank/import` recebe o OFX ou CSV no corpo (até 3 MB e 5.000 lançamentos), ignora lançamentos repetidos (FITID ou data+descrição+valor) e sugere a conciliação pelo mesmo valor e data próxima.

## O que ainda depende de provedor externo (fora desta API)

Emissão fiscal real (SEFAZ), PSP de PIX com webhook, Open Finance, OAuth do Mercado Livre/Shopee/Amazon/Magalu, gateway de pagamento da assinatura, envio de e-mail/WhatsApp de comprovantes e login com Google. A API já tem os pontos de encaixe; falta contratar e ligar cada provedor.
