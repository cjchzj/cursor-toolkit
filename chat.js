const CHORD = /^(?:(?:ctrl|alt|shift|win)\+)+(?:f(?:1[0-2]|[1-9])|[a-z0-9]|space|enter|tab|left|right|up|down|escape)$/i;

function normalizeChord(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function validChord(value) {
  return CHORD.test(normalizeChord(value));
}

async function listModels(vscode) {
  if (!vscode.lm?.selectChatModels) return [];
  const models = await vscode.lm.selectChatModels();
  return models
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      vendor: model.vendor || '',
      family: model.family || '',
    }))
    .sort((a, b) => rank(a) - rank(b));
}

function rank(model) {
  const text = `${model.id} ${model.name} ${model.family}`.toLowerCase();
  if (text.includes('grok')) return 0;
  if (text.includes('composer')) return 1;
  return 2;
}

async function sendChat(vscode, { modelId, prompt, images, token, onDelta }) {
  if (!vscode.lm?.selectChatModels) return { ok: false, reason: 'no-model' };
  const models = await vscode.lm.selectChatModels();
  if (!models.length) return { ok: false, reason: 'no-model' };
  const ranked = [...models].sort((a, b) => rank(a) - rank(b));
  const model = models.find((item) => item.id === modelId) || ranked[0];
  const parts = [];
  if (vscode.LanguageModelTextPart) parts.push(new vscode.LanguageModelTextPart(prompt));
  for (const image of images) {
    if (vscode.LanguageModelDataPart?.image) {
      parts.push(vscode.LanguageModelDataPart.image(image.bytes, image.mime));
    }
  }
  const content = parts.length ? parts : prompt;
  const messages = [vscode.LanguageModelChatMessage.User(content)];
  const source = new vscode.CancellationTokenSource();
  const abort = () => source.cancel();
  token?.addEventListener?.('abort', abort);
  try {
    const response = await model.sendRequest(messages, {
      justification: '在工作台悬浮窗里继续这段对话',
    }, source.token);
    let text = '';
    for await (const delta of response.text) {
      text += delta;
      onDelta(delta);
    }
    return { ok: true, text, model: model.name || model.id };
  } finally {
    token?.removeEventListener?.('abort', abort);
    source.dispose();
  }
}

async function openCursorChat(vscode, prompt) {
  await vscode.env.clipboard.writeText(prompt);
  const commands = await vscode.commands.getCommands(true);
  const preferred = [
    'composer.newAgentChat',
    'aichat.newchataction',
    'composer.startComposerPrompt',
    'workbench.action.chat.newChat',
  ];
  const guess = commands.find((id) => /composer\.(new|create|open)/i.test(id) || /aichat\.new/i.test(id));
  const command = preferred.find((id) => commands.includes(id)) || guess || null;
  if (command) {
    try {
      await vscode.commands.executeCommand(command);
    } catch {
      /* the clipboard still has the prompt */
    }
  }
  return { ok: false, reason: 'fallback', command };
}

module.exports = { listModels, sendChat, openCursorChat, normalizeChord, validChord };
