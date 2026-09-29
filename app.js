// =============================================================================
// BOT SLACK -> SALESFORCE MARKETING CLOUD (SFMC)
// -----------------------------------------------------------------------------
// O que este bot faz:
//   1. Escuta o slash command /criar-edital no Slack
//   2. Abre um modal (formulário) pedindo nome do edital, data da live e link
//   3. Ao enviar o formulário, autentica no SFMC (OAuth 2.0)
//   4. Cria um e-mail HTML no Content Builder via API REST
//   5. Avisa o usuário no Slack se deu certo ou errado
//
// IMPORTANTE: nenhuma credencial fica escrita aqui. Tudo vem do arquivo .env
// (veja o .env.example). Nunca suba o .env para o Git.
// =============================================================================

// Carrega as variáveis do arquivo .env para dentro de process.env
require('dotenv').config();

// SDK do Slack (Bolt) para criar o app, comandos, modais etc.
const { App } = require('@slack/bolt');

// Biblioteca para fazer requisições HTTP (usada para chamar a API do SFMC)
const axios = require('axios');

// -----------------------------------------------------------------------------
// INICIALIZAÇÃO DO APP DO SLACK
// -----------------------------------------------------------------------------
// Socket Mode: o Slack se conecta ao bot via WebSocket, então não é preciso
// expor uma URL pública (útil para rodar localmente ou em rede interna).
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,   // Bot Token (começa com xoxb-)
  appToken: process.env.SLACK_APP_TOKEN, // App-Level Token (começa com xapp-), exigido pelo Socket Mode
  socketMode: true,
});

// -----------------------------------------------------------------------------
// FUNÇÃO: OBTER TOKEN OAUTH 2.0 DO SFMC
// -----------------------------------------------------------------------------
// Autentica no SFMC usando as credenciais do Installed Package (API Integration)
// e devolve um access_token temporário, usado nas chamadas seguintes.
async function getSFMCToken() {
  // Endpoint de autenticação do seu tenant: https://<subdomínio>.auth.marketingcloudapis.com/v2/token
  const url = `${process.env.SFMC_AUTH_URI}/v2/token`;

  // Corpo da requisição no fluxo "client credentials" (server-to-server)
  const body = {
    grant_type: 'client_credentials',
    client_id: process.env.SFMC_CLIENT_ID,         // Client ID do Installed Package
    client_secret: process.env.SFMC_CLIENT_SECRET, // Client Secret do Installed Package
    account_id: process.env.SFMC_ACCOUNT_ID        // MID da Business Unit onde o e-mail será criado
  };

  const response = await axios.post(url, body);

  // O SFMC devolve o token no campo access_token
  return response.data.access_token;
}

// -----------------------------------------------------------------------------
// FUNÇÃO: CRIAR E-MAIL NO CONTENT BUILDER
// -----------------------------------------------------------------------------
// Parâmetros:
//   token       -> access_token obtido em getSFMCToken()
//   nomeEdital  -> nome do concurso/edital (vem do modal)
//   dataLive    -> data e hora da live, em texto livre (vem do modal)
//   linkYoutube -> link da transmissão (vem do modal)
async function createSFMCEmail(token, nomeEdital, dataLive, linkYoutube) {
  // Endpoint da API de Assets do Content Builder: https://<subdomínio>.rest.marketingcloudapis.com/asset/v1/content/assets
  const url = `${process.env.SFMC_REST_URI}/asset/v1/content/assets`;

  // HTML do e-mail, montado com os dados informados no formulário.
  // (Atenção: os valores são inseridos sem sanitização; ver observação no final do arquivo.)
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <body>
      <h2>Lançamento do Edital: ${nomeEdital}</h2>
      <p>Acompanhe a nossa live especial no dia <strong>${dataLive}</strong>.</p>
      <p><a href="${linkYoutube}" style="background-color:#0070d2;color:white;padding:10px 20px;text-decoration:none;border-radius:4px;">Assistir no YouTube</a></p>
    </body>
    </html>
  `;

  // Corpo da requisição que define o asset (e-mail) a ser criado
  const body = {
    // Nome único: o Date.now() evita erro de nome duplicado no Content Builder
    name: `Edital - ${nomeEdital} (${Date.now()})`,

    // Tipo do asset: 208 é o ID oficial do SFMC para "HTML Email"
    assetType: {
      id: 208,
      name: 'htmlemail'
    },

    // Pasta do Content Builder onde o e-mail será salvo.
    // Se SFMC_CATEGORY_ID não estiver definido, usa 0 (pasta raiz).
    category: {
      id: parseInt(process.env.SFMC_CATEGORY_ID) || 0
    },

    // Conteúdo da view HTML do e-mail
    views: {
      html: {
        content: htmlContent
      }
    }
  };

  // Envia a requisição autenticada com o Bearer Token
  const response = await axios.post(url, body, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  // Retorna os dados do asset criado (id, name, etc.)
  return response.data;
}

// TODO (anotação original): passar o HTML completo do e-mail para este fluxo.

// -----------------------------------------------------------------------------
// 1. SLASH COMMAND /criar-edital -> ABRE O MODAL (FORMULÁRIO)
// -----------------------------------------------------------------------------
app.command('/criar-edital', async ({ ack, body, client }) => {
  // O Slack exige uma confirmação (ack) em até 3 segundos, senão mostra erro ao usuário
  await ack();

  try {
    // Abre o modal usando o trigger_id recebido do comando (válido por poucos segundos)
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'modal_criar_edital', // Identificador usado em app.view() para capturar o envio
        title: {
          type: 'plain_text',
          text: 'Novo Edital SFMC'
        },
        submit: {
          type: 'plain_text',
          text: 'Criar no SFMC' // Texto do botão de envio
        },
        close: {
          type: 'plain_text',
          text: 'Cancelar' // Texto do botão de fechar
        },
        blocks: [
          // Campo 1: nome do concurso/edital
          {
            type: 'input',
            block_id: 'block_nome',       // Usado para ler o valor depois
            element: {
              type: 'plain_text_input',
              action_id: 'input_nome',    // Usado para ler o valor depois
              placeholder: { type: 'plain_text', text: 'Ex: Polícia Federal PB' }
            },
            label: { type: 'plain_text', text: 'Nome do Concurso/Edital' }
          },
          // Campo 2: data e hora da live (texto livre)
          {
            type: 'input',
            block_id: 'block_data',
            element: {
              type: 'plain_text_input',
              action_id: 'input_data',
              placeholder: { type: 'plain_text', text: 'Ex: 15/10/2026 às 19:00' }
            },
            label: { type: 'plain_text', text: 'Data e Hora da Live' }
          },
          // Campo 3: link da transmissão no YouTube
          {
            type: 'input',
            block_id: 'block_link',
            element: {
              type: 'plain_text_input',
              action_id: 'input_link',
              placeholder: { type: 'plain_text', text: 'https://youtube.com/...' }
            },
            label: { type: 'plain_text', text: 'Link da Transmissão no YouTube' }
          }
        ]
      }
    });
  } catch (error) {
    // Se falhar ao abrir o modal, registra no console do servidor
    console.error('Erro ao abrir o modal:', error);
  }
});

// -----------------------------------------------------------------------------
// 2. ENVIO DO MODAL -> CRIA O E-MAIL NO SFMC
// -----------------------------------------------------------------------------
// Executado quando o usuário clica em "Criar no SFMC".
// O callback_id precisa ser igual ao definido no modal acima.
app.view('modal_criar_edital', async ({ ack, body, view, client }) => {
  // Confirma o recebimento do formulário (fecha o modal)
  await ack();

  // ID do usuário que enviou o formulário (usado para mandar mensagem privada)
  const user = body.user.id;

  // Valores preenchidos, organizados por block_id -> action_id
  const values = view.state.values;

  const nomeEdital = values.block_nome.input_nome.value;
  const dataLive = values.block_data.input_data.value;
  const linkYoutube = values.block_link.input_link.value;

  try {
    // Avisa o usuário (por mensagem direta) que o processo começou
    await client.chat.postMessage({
      channel: user,
      text: `⏳ Processando a criação do e-mail para *${nomeEdital}* no Marketing Cloud...`
    });

    // Passo 1: autentica no SFMC e obtém o token
    const sfmcToken = await getSFMCToken();

    // Passo 2: cria o e-mail no Content Builder
    const assetCreated = await createSFMCEmail(sfmcToken, nomeEdital, dataLive, linkYoutube);

    // Passo 3: confirma o sucesso, mostrando o ID e o nome do asset criado
    await client.chat.postMessage({
      channel: user,
      text: `✅ *Sucesso!* O e-mail para o edital *${nomeEdital}* foi criado no Marketing Cloud.\n• *Asset ID:* \`${assetCreated.id}\`\n• *Nome:* ${assetCreated.name}`
    });

  } catch (error) {
    // Registra o erro detalhado no console (usa a resposta da API quando existir)
    console.error('Erro na integração com o SFMC:', error.response ? error.response.data : error.message);

    // Avisa o usuário no Slack que algo falhou
    await client.chat.postMessage({
      channel: user,
      text: `❌ *Erro ao criar no Marketing Cloud:* ${error.message}`
    });
  }
});

// -----------------------------------------------------------------------------
// INICIALIZAÇÃO DO SERVIDOR
// -----------------------------------------------------------------------------
// Função autoexecutável assíncrona: inicia o app e conecta ao Slack via Socket Mode
(async () => {
  await app.start();
  console.log('⚡️ E-mail Bot intermediário está rodando!');
})();

// =============================================================================
// OBSERVAÇÕES:
// - Os campos do formulário (nome, data, link) entram direto no HTML do e-mail.
//   Se o bot for usado por muita gente, vale escapar o HTML desses valores e
//   validar que o link começa com https:// para evitar conteúdo indevido.
// - O token OAuth do SFMC expira (cerca de 20 minutos). Como o bot pede um novo
//   a cada envio, isso não é problema, mas dá para fazer cache se o uso crescer.
// =============================================================================
