require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Events,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  AttachmentBuilder
} = require('discord.js');
const fetch = require('node-fetch');

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = '1287618065143562240';
const DISCORD_INVITE = 'https://discord.gg/Y9p5W5Bx';
const FIXED_IP = 'heartlessmc.playcraft.me';


if (!TOKEN) {
  console.error("❌ BOT_TOKEN not found in .env file");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const setupChannels = new Map();
const statusCache = new Map();
const commandPermissions = new Map();
const monitoringStatus = new Map();

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName('setup').setDescription('Create a status channel.'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop monitoring the server.'),
    new SlashCommandBuilder().setName('start').setDescription('Resume monitoring the server.'),
    new SlashCommandBuilder()
      .setName('msg')
      .setDescription('Send maintenance or stop message')
      .addStringOption(opt =>
        opt.setName('type').setDescription('Type').setRequired(true)
          .addChoices({ name: 'maintenance', value: 'maintenance' }, { name: 'server_stop', value: 'server_stop' })
      )
      .addStringOption(opt =>
        opt.setName('time').setDescription('Estimated time (e.g. 1h, 5m)').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('perm')
      .setDescription('Allow/Deny role to use command')
      .addRoleOption(opt => opt.setName('role').setDescription('Role').setRequired(true))
      .addStringOption(opt =>
        opt.setName('permission').setDescription('Command')
          .addChoices(
            { name: 'setup', value: 'setup' },
            { name: 'stop', value: 'stop' },
            { name: 'start', value: 'start' },
            { name: 'msg', value: 'msg' },
            { name: 'del', value: 'del' },
            { name: 'perm', value: 'perm' },
            { name: 'perm_list', value: 'perm_list' }
          )
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('toggle').setDescription('Allow or deny')
          .addChoices({ name: 'allow', value: 'allow' }, { name: 'deny', value: 'deny' })
          .setRequired(true)
      ),
    new SlashCommandBuilder().setName('perm_list').setDescription('List role permissions.'),
    new SlashCommandBuilder().setName('del').setDescription('Delete channel messages (admin only)')
  ].map(cmd => cmd.setDMPermission(false).toJSON());

  await client.application.commands.set(commands, GUILD_ID);
  console.log('📡 Commands registered.');

  setInterval(async () => {
    for (const [guildId, channelId] of setupChannels.entries()) {
      if (!monitoringStatus.get(guildId)) continue;

      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) continue;

        const response = await fetch(`https://api.mcsrvstat.us/2/${FIXED_IP}`);
        const data = await response.json();

        if (!data || !data.online) {
          await channel.send(`❌ Server ${FIXED_IP} is offline.`);
          continue;
        }

        const status = {
          status: 'online',
          name: data.hostname || FIXED_IP,
          players: `${data.players.online}/${data.players.max}`,
          version: data.version,
          motd: data.motd.clean.join('\n'),
          protocol: data.protocol || 'Unknown',
          icon: data.icon ? Buffer.from(data.icon.split(',')[1], 'base64') : null
        };

        const msgPayload = formatStatusMessage(status, FIXED_IP);
        const lastMsgId = statusCache.get(guildId);

        if (lastMsgId) {
          try {
            const lastMsg = await channel.messages.fetch(lastMsgId);
            await lastMsg.edit(msgPayload);
            continue;
          } catch {}
        }

        const sent = await channel.send(msgPayload);
        statusCache.set(guildId, sent.id);
      } catch (err) {
        console.error('Monitoring error:', err);
      }
    }
  }, 5000);
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, guild } = interaction;
  const member = await guild.members.fetch(interaction.user.id);
  const perms = commandPermissions.get(guild.id);
  const allowedRoles = perms?.[commandName];

  if (allowedRoles && !member.roles.cache.some(r => allowedRoles.includes(r.id))) {
    return interaction.reply({ content: '⛔ No permission for this command.', ephemeral: true });
  }

  if (commandName === 'setup') {
    let channel = guild.channels.cache.find(c => c.name === 'server-status' && c.type === ChannelType.GuildText);
    if (!channel) {
      channel = await guild.channels.create({
        name: 'server-status',
        type: ChannelType.GuildText,
        permissionOverwrites: [{
          id: guild.roles.everyone.id,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]
        }]
      });
    }

    setupChannels.set(guild.id, channel.id);
    monitoringStatus.set(guild.id, true);
    return interaction.reply(`✅ Monitoring ${FIXED_IP} in ${channel}`);
  }

  if (commandName === 'stop') {
    monitoringStatus.set(guild.id, false);
    return interaction.reply('🛑 Monitoring stopped.');
  }

  if (commandName === 'start') {
    if (!setupChannels.has(guild.id)) return interaction.reply('⚠️ Run /setup first.');
    monitoringStatus.set(guild.id, true);
    return interaction.reply('✅ Monitoring resumed.');
  }

  if (commandName === 'msg') {
    const type = options.getString('type');
    const time = options.getString('time');
    const channelId = setupChannels.get(guild.id);

    if (!channelId) return interaction.reply({ content: '⚠️ Run /setup first.', ephemeral: true });

    const channel = await client.channels.fetch(channelId);
    const embed = new EmbedBuilder()
      .setTitle('💖 Heartless Lifesteal SMP')
      .setDescription(
        type === 'maintenance'
          ? '🛠️ **Maintenance Notice**\nUpgrading the server. Check back later.'
          : '🛑 **Server Offline Temporarily**\nWorking on backend improvements.'
      )
      .addFields({ name: '🕒 Estimated Time', value: time })
      .setColor(type === 'maintenance' ? 0xffd700 : 0xdc143c)
      .setFooter({ text: 'Thank you for your patience 💖' })
      .setTimestamp();

    const data = await (await fetch(`https://api.mcsrvstat.us/2/${FIXED_IP}`)).json();
    const buffer = data.icon ? Buffer.from(data.icon.split(',')[1], 'base64') : null;

    const attachment = buffer ? new AttachmentBuilder(buffer, { name: 'server-icon.png' }) : null;
    if (attachment) embed.setThumbnail('attachment://server-icon.png');

    await interaction.reply({ content: '✅ Message sent.', ephemeral: true });
    await channel.send({ embeds: [embed], files: attachment ? [attachment] : [] });
  }

  if (commandName === 'perm') {
    const fullGuild = await client.guilds.fetch(guild.id);
    const isOwner = interaction.user.id === fullGuild.ownerId;
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
    if (!isOwner && !isAdmin) return interaction.reply({ content: '⛔ Only owner/admin can change permissions.', ephemeral: true });

    const role = options.getRole('role');
    const permission = options.getString('permission');
    const toggle = options.getString('toggle');

    const perms = commandPermissions.get(guild.id) || {};
    if (!perms[permission]) perms[permission] = [];

    if (toggle === 'allow') {
      if (!perms[permission].includes(role.id)) perms[permission].push(role.id);
    } else {
      perms[permission] = perms[permission].filter(id => id !== role.id);
    }

    commandPermissions.set(guild.id, perms);
    return interaction.reply(`✅ ${toggle}ed ${permission} for ${role}`);
  }

  if (commandName === 'perm_list') {
    const perms = commandPermissions.get(guild.id) || {};
    if (!Object.keys(perms).length) {
      return interaction.reply({ content: '📭 No permissions configured.', ephemeral: true });
    }

    const lines = Object.entries(perms).map(([cmd, roles]) =>
      `🔹 **/${cmd}**: ${roles.map(r => `<@&${r}>`).join(', ') || 'None'}`
    );
    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }

  if (commandName === 'del') {
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin) return interaction.reply({ content: '⛔ Admin only.', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.channel;
    let deleted = 0;

    try {
      let fetched;
      do {
        fetched = await channel.messages.fetch({ limit: 100 });
        const deletable = fetched.filter(msg => !msg.pinned && (Date.now() - msg.createdTimestamp) < 1209600000);
        await channel.bulkDelete(deletable, true);
        deleted += deletable.size;
      } while (fetched.size >= 2);

      await interaction.editReply(`✅ Deleted ${deleted} messages.`);
    } catch (err) {
      console.error('❌ Delete error:', err);
      await interaction.editReply('❌ Could not delete messages.');
    }
  }
});

function formatStatusMessage(status, ip) {
  const embed = new EmbedBuilder()
    .setTitle(`🟢 ${String(status.name)}`)
    .addFields(
      { name: '📊 Status', value: String(capitalize(status.status)), inline: true },
      { name: '👥 Players', value: String(status.players), inline: true },
      { name: '📦 Version', value: String(status.version || 'Unknown'), inline: true },
      { name: '🌐 IP', value: String(ip) },
      { name: '📜 MOTD', value: String(status.motd || 'N/A').slice(0, 1024) },
      { name: '🔗 Protocol', value: String(status.protocol || 'Unknown') }
    )
    .setColor(0x00ff00)
    .setFooter({ text: 'Last Updated' })
    .setTimestamp();

  const files = [];
  if (status.icon) {
    const attachment = new AttachmentBuilder(status.icon, { name: 'server-icon.png' });
    embed.setThumbnail('attachment://server-icon.png');
    files.push(attachment);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Join Server')
      .setStyle(ButtonStyle.Link)
      .setURL(DISCORD_INVITE)
      .setEmoji('🌐')
  );

  return { embeds: [embed], files, components: [row] };
}


function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));

client.login(TOKEN);
