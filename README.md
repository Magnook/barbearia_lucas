# De Lucas — Agendador

## Estrutura
- `public/index.html` — o site
- `netlify/functions/api.mjs` — servidor (agendar, listar, cancelar) com Netlify Blobs
- `netlify.toml` e `package.json` — configuração

## Publicar (via GitHub)
1. Crie um repositório no GitHub e suba **todo o conteúdo desta pasta**.
2. No Netlify: Add new site → Import an existing project → escolha o repositório.
3. Não precisa preencher build command. Publish directory = `public` (o `netlify.toml` já define).
4. Antes do deploy (ou logo depois), vá em Site configuration → Environment variables e crie:
   - `BARBER_KEY` = a senha da Agenda do barbeiro
5. Se criou a variável depois do primeiro deploy: Deploys → Trigger deploy → Deploy site.

O armazenamento (Netlify Blobs) funciona sozinho no site publicado, sem configurar nada.

## Como funciona
- Cliente: marca com nome, WhatsApp e um código de 4 números. Para cancelar, usa WhatsApp + código.
- Barbeiro: "Ver Agenda" pede a senha (`BARBER_KEY`) e mostra nomes/telefones; pode cancelar qualquer horário.
- O servidor valida tudo (folga, almoço, domingo, horário passado) e limita tentativas erradas por IP.
