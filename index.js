require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const { Client, GatewayIntentBits, SlashCommandBuilder, Events, ChannelType, PermissionsBitField, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const fetch = require('node-fetch');

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = '1287618065143562240';
const DISCORD_INVITE = 'https://discord.gg/Y9p5W5Bx';
const FIXED_IP = 'heartlessmc.playcraft.me';

if (!TOKEN) {
  console.error("❌ BOT_TOKEN not found in .env file");
  process.exit(1);
}

const db = new sqlite3.Database('./permissions.db', (err) => {
  if (err) console.error('❌ Database Error:', err.message);
  else console.log('✅ Connected to SQLite database.');
});

db.run(`CREATE TABLE IF NOT EXISTS permissions (
  guildId TEXT,
  commandName TEXT,
  roleId TEXT,
  PRIMARY KEY (guildId, commandName, roleId)
)`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const setupChannels = new Map();
const statusCache = new Map();
const monitoringStatus = new Map();

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName('setup').setDescription('Create a status channel.'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop monitoring the server.'),
    new SlashCommandBuilder().setName('start').setDescription('Resume monitoring the server.'),
    new SlashCommandBuilder()
      .setName('msg').setDescription('Send maintenance or stop message')
      .addStringOption(opt => opt.setName('type').setDescription('Type').setRequired(true)
        .addChoices({ name: 'maintenance', value: 'maintenance' }, { name: 'server_stop', value: 'server_stop' }))
      .addStringOption(opt => opt.setName('time').setDescription('Estimated time').setRequired(true)),
    new SlashCommandBuilder()
      .setName('perm').setDescription('Allow/Deny role to use command')
      .addRoleOption(opt => opt.setName('role').setDescription('Role').setRequired(true))
      .addStringOption(opt => opt.setName('permission').setDescription('Command')
        .addChoices(
          { name: 'setup', value: 'setup' }, { name: 'stop', value: 'stop' },
          { name: 'start', value: 'start' }, { name: 'msg', value: 'msg' },
          { name: 'del', value: 'del' }, { name: 'perm', value: 'perm' },
          { name: 'perm_list', value: 'perm_list' })
        .setRequired(true))
      .addStringOption(opt => opt.setName('toggle').setDescription('Allow or deny')
        .addChoices({ name: 'allow', value: 'allow' }, { name: 'deny', value: 'deny' }).setRequired(true)),
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
          } catch { }
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

  if (await hasPermission(guild.id, commandName, member)) {

    if (commandName === 'msg') {
      const type = options.getString('type');
      const time = options.getString('time');

      let embed;
      if (type === 'maintenance') {
        embed = new EmbedBuilder()
          .setTitle('🚧 Maintenance In Progress')
          .setDescription('The server is currently undergoing **scheduled maintenance**.\n\n🔧 Our team is working hard to improve your experience.\n\nPlease be patient and check back soon!')
          .addFields({ name: '⏳ Estimated Time', value: `\`${time}\`` })
          .setColor(0xFFA500)
          .setThumbnail('https://cdn-icons-png.flaticon.com/512/3524/3524659.png')
          .setFooter({ text: 'Maintenance Mode' })
          .setTimestamp();
      } else if (type === 'server_stop') {
        embed = new EmbedBuilder()
          .setTitle('🛑 Server Stopped')
          .setDescription('The server is currently **offline or stopped**.\n\n⚠️ Please wait for further announcements or updates.')
          .addFields({ name: '⏳ Expected Back In', value: `\`${time}\`` })
          .setColor(0xFF0000)
          .setThumbnail('https://cdn-icons-png.flaticon.com/512/1828/1828665.png')
          .setFooter({ text: 'Server Offline' })
          .setTimestamp();
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Join Our Discord')
          .setStyle(ButtonStyle.Link)
          .setURL(DISCORD_INVITE)
          .setEmoji('🔗')
      );

      await interaction.reply({ embeds: [embed], components: [row] });
    }

    if (commandName === 'setup') { /* your setup code */ }
    if (commandName === 'stop') { /* your stop code */ }
    if (commandName === 'start') { /* your start code */ }
    if (commandName === 'perm') {
      const fullGuild = await client.guilds.fetch(guild.id);
      const isOwner = interaction.user.id === fullGuild.ownerId;
      const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!isOwner && !isAdmin) return interaction.reply({ content: '⛔ Only owner/admin.', ephemeral: true });

      const role = options.getRole('role');
      const permission = options.getString('permission');
      const toggle = options.getString('toggle');

      if (toggle === 'allow') {
        db.run(`INSERT OR IGNORE INTO permissions(guildId, commandName, roleId) VALUES (?, ?, ?)`, [guild.id, permission, role.id]);
      } else {
        db.run(`DELETE FROM permissions WHERE guildId = ? AND commandName = ? AND roleId = ?`, [guild.id, permission, role.id]);
      }
      return interaction.reply(`✅ ${toggle}ed ${permission} for ${role}`);
    }

    if (commandName === 'perm_list') {
      db.all(`SELECT * FROM permissions WHERE guildId = ?`, [guild.id], (err, rows) => {
        if (err) return interaction.reply({ content: '❌ DB error.', ephemeral: true });

        if (!rows.length) return interaction.reply({ content: '📭 No permissions configured.', ephemeral: true });

        const perms = {};
        rows.forEach(row => {
          if (!perms[row.commandName]) perms[row.commandName] = [];
          perms[row.commandName].push(`<@&${row.roleId}>`);
        });

        const lines = Object.entries(perms).map(([cmd, roles]) => `🔹 **/${cmd}**: ${roles.join(', ') || 'None'}`);
        interaction.reply({ content: lines.join('\n'), ephemeral: true });
      });
    }

    if (commandName === 'del') { /* your delete code */ }

  } else {
    return interaction.reply({ content: '⛔ No permission for this command.', ephemeral: true });
  }
});

function hasPermission(guildId, commandName, member) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT roleId FROM permissions WHERE guildId = ? AND commandName = ?`, [guildId, commandName], (err, rows) => {
      if (err) return reject(err);
      if (!rows.length) return resolve(true);
      const allowed = rows.some(r => member.roles.cache.has(r.roleId));
      resolve(allowed);
    });
  });
}

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