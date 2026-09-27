import { runtime } from '../config.js';

export async function handleGroupEvent(sock, ev) {
  const { id, participants, action } = ev;
  
  for (const p of participants) {
    const jid = typeof p === 'string' ? p : p.id;
    
    if (action === 'add' && runtime.welcome.get(id)) {
      const tpl = runtime.customWelcome.get(id) || '👋 Welcome @user to @group!';
      const text = tpl
        .replace(/@user/g, `@${jid.split('@')[0]}`)
        .replace(/@group/g, id.split('@')[0]);
      await sock.sendMessage(id, { text, mentions: [jid] }).catch(() => {});
    }
    
    if (action === 'remove' && runtime.goodbye.get(id)) {
      const tpl = runtime.customGoodbye.get(id) || '👋 @user left the group.';
      const text = tpl.replace(/@user/g, `@${jid.split('@')[0]}`);
      await sock.sendMessage(id, { text, mentions: [jid] }).catch(() => {});
    }
  }
}