export default {
  ping: async ({ reply }) => {
    const start = Date.now();
    await reply({ text: `🏓 Pong! ${Date.now() - start}ms` });
  },
  
  help: async ({ reply }) => {
    const helpText = `
*🤖 Bot Commands*

*Info*
.ping — Check latency
.help — This menu
.info — Bot information

*Group*
.tagall — Mention everyone
.groupinfo — Group details
.promote / .demote — Admin controls

*Owner*
.restart — Restart bot
.broadcast — Send to all chats

*AI*
.ai <prompt> — Ask the AI
    `.trim();
    await reply({ text: helpText });
  },
  
  info: async ({ sock, reply }) => {
    const user = sock.user;
    await reply({
      text: `*Bot Info*\n📱 ${user?.id?.split(':')[0]}\n🟢 Online\n⚙️ Baileys`,
    });
  },
};