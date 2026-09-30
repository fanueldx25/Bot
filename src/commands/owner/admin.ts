import { registerCommand, reply, CommandContext } from '../../lib/commandHandler.ts';
import { updateConfig } from '../../lib/config.ts';

registerCommand({
  name: 'setmode',
  category: 'owner',
  description: 'Change bot mode (public/private)',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ This command is owner only.', ctx.mek);
      return;
    }
    
    const mode = ctx.args[0]?.toLowerCase();
    if (mode !== 'public' && mode !== 'private') {
      await reply(ctx.sock, ctx.from, '❌ Usage: .setmode public|private', ctx.mek);
      return;
    }

    await updateConfig({ mode: mode as 'public' | 'private' });
    await reply(ctx.sock, ctx.from, `✅ Bot mode changed to *${mode}*`, ctx.mek);
    return;
  }
});

registerCommand({
  name: 'setprefix',
  category: 'owner',
  description: 'Change bot prefix',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ This command is owner only.', ctx.mek);
      return;
    }
    
    const prefix = ctx.args[0];
    if (!prefix) {
      await reply(ctx.sock, ctx.from, '❌ Please provide a new prefix.', ctx.mek);
      return;
    }

    await updateConfig({ prefix });
    await reply(ctx.sock, ctx.from, `✅ Prefix changed to *${prefix}*`, ctx.mek);
    return;
  }
});

registerCommand({
  name: 'eval',
  category: 'owner',
  description: 'Evaluate javascript code',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ This command is owner only.', ctx.mek);
      return;
    }
    if (!ctx.q) {
      await reply(ctx.sock, ctx.from, '❌ Please provide code to eval.', ctx.mek);
      return;
    }

    try {
      const result = eval(ctx.q);
      await reply(ctx.sock, ctx.from, `✅ *Eval Result:*\n\`\`\`${JSON.stringify(result, null, 2)}\`\`\``, ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ *Eval Error:*\n\`\`\`${err.message}\`\`\``, ctx.mek);
    }
    return;
  }
});

registerCommand({
  name: 'setcookies',
  category: 'owner',
  description: 'Update YouTube cookies.txt',
  execute: async (ctx: CommandContext) => {
    if (!ctx.isOwner) {
      await reply(ctx.sock, ctx.from, '❌ This command is owner only.', ctx.mek);
      return;
    }
    if (!ctx.q) {
      await reply(ctx.sock, ctx.from, '❌ Please provide the cookie content.', ctx.mek);
      return;
    }

    try {
      const fs = await import('fs');
      const path = await import('path');
      fs.writeFileSync(path.join(process.cwd(), 'cookies.txt'), ctx.q);
      await reply(ctx.sock, ctx.from, '✅ *cookies.txt* successfully updated!', ctx.mek);
    } catch (err: any) {
      await reply(ctx.sock, ctx.from, `❌ Error: ${err.message}`, ctx.mek);
    }
    return;
  }
});
