import { registerCommand, reply, CommandContext } from '../../lib/commandHandler.ts';
import { updateConfig, getConfig } from '../../lib/config.ts';

registerCommand({
  name: 'antilink',
  category: 'owner',
  description: 'Enable or disable anti-link protection',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }
    const status = ctx.args[0]?.toLowerCase();
    if (status !== 'on' && status !== 'off') {
      await reply(ctx.sock, ctx.from, '❌ Usage: .antilink on / .antilink off', ctx.mek);
      return;
    }
    const enable = status === 'on';
    await updateConfig({ antiLink: enable });
    await reply(ctx.sock, ctx.from, `✅ Anti-Link is now *${status.toUpperCase()}*`, ctx.mek);
    return;
  }
});

registerCommand({
  name: 'antidelete',
  category: 'owner',
  description: 'Enable or disable anti-delete message tracking',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }
    const status = ctx.args[0]?.toLowerCase();
    if (status !== 'on' && status !== 'off') {
      await reply(ctx.sock, ctx.from, '❌ Usage: .antidelete on / .antidelete off', ctx.mek);
      return;
    }
    const enable = status === 'on';
    await updateConfig({ antiDelete: enable });
    await reply(ctx.sock, ctx.from, `✅ Anti-Delete is now *${status.toUpperCase()}*`, ctx.mek);
    return;
  }
});

registerCommand({
  name: 'autostatus',
  aliases: ['autoreactstatus'],
  category: 'owner',
  description: 'Enable or disable automatic status reactions',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ Owner only command.', ctx.mek);
      return;
    }
    const status = ctx.args[0]?.toLowerCase();
    if (status !== 'on' && status !== 'off') {
      await reply(ctx.sock, ctx.from, '❌ Usage: .autostatus on / .autostatus off', ctx.mek);
      return;
    }
    const enable = status === 'on';
    await updateConfig({ autoStatusReact: enable });
    await reply(ctx.sock, ctx.from, `✅ Auto Status Reaction is now *${status.toUpperCase()}*`, ctx.mek);
    return;
  }
});
